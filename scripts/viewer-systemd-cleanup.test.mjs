import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withViewerSystemdFixture } from "./viewer-systemd-fixtures.mjs";

test("unit failures still wait for the owner and remove the home", async () => {
  const fixture = recordingFixture();
  const owner = new EventEmitter();
  const primary = new Error("synthetic test failure");
  const scopeFailure = new Error("synthetic scope stop failure");
  const serviceFailure = new Error("synthetic service stop failure");
  fixture.options.stopUnit = async (unit) => {
    if (unit.endsWith(".scope")) {
      fixture.events.push("stop-scope");
      throw scopeFailure;
    }

    fixture.events.push("stop-service");
    setTimeout(() => {
      fixture.events.push("owner-exit");
      owner.emit("exit", 0, null);
    }, 5);
    throw serviceFailure;
  };

  const failure = await captureFailure(withViewerSystemdFixture(true, ({ watchOwner }) => {
    watchOwner(owner);
    throw primary;
  }, fixture.options));

  assert.deepEqual(fixture.events, ["stop-scope", "stop-service", "owner-exit", "remove-home"]);
  assert(failure instanceof AggregateError);
  assert.equal(failure.cause, primary);
  assert.deepEqual(failure.errors, [primary, scopeFailure, serviceFailure]);
});

test("owner rejection still removes the home and retains the test failure", async () => {
  const fixture = recordingFixture();
  const primary = new Error("synthetic assertion failure");
  const ownerFailure = new Error("synthetic spawn failure");

  const failure = await captureFailure(withViewerSystemdFixture(false, ({ watchOwner }) => {
    const owner = new EventEmitter();
    watchOwner(owner);
    owner.emit("error", ownerFailure);
    throw primary;
  }, fixture.options));

  assert.deepEqual(fixture.events, ["stop-scope", "remove-home"]);
  assert(failure instanceof AggregateError);
  assert.equal(failure.cause, primary);
  assert.deepEqual(failure.errors, [primary, ownerFailure]);
});

test("every cleanup error is retained with the original failure first", async () => {
  const fixture = recordingFixture();
  const primary = new Error("synthetic assertion failure");
  const stopFailure = new Error("synthetic manager failure");
  const ownerFailure = new Error("synthetic owner failure");
  const removeFailure = new Error("synthetic filesystem failure");
  fixture.options.stopUnit = async () => { throw stopFailure; };
  fixture.options.removeHome = async () => { throw removeFailure; };

  const failure = await captureFailure(withViewerSystemdFixture(true, ({ watchOwner }) => {
    const owner = new EventEmitter();
    watchOwner(owner);
    owner.emit("error", ownerFailure);
    throw primary;
  }, fixture.options));

  assert(failure instanceof AggregateError);
  assert.equal(failure.cause, primary);
  assert.deepEqual(failure.errors, [primary, stopFailure, stopFailure, ownerFailure, removeFailure]);
});

test("synchronous cleanup throws still attempt both stops and home removal", async () => {
  const fixture = recordingFixture();
  const primary = new Error("synthetic test failure");
  const stopFailure = new Error("synthetic synchronous stop failure");
  const removeFailure = new Error("synthetic synchronous removal failure");
  fixture.options.stopUnit = (unit) => {
    fixture.events.push(unit.endsWith(".scope") ? "stop-scope" : "stop-service");
    throw stopFailure;
  };
  fixture.options.removeHome = () => {
    fixture.events.push("remove-home");
    throw removeFailure;
  };

  const failure = await captureFailure(withViewerSystemdFixture(true, ({ watchOwner }) => {
    const owner = new EventEmitter();
    watchOwner(owner);
    owner.emit("exit", 0, null);
    throw primary;
  }, fixture.options));

  assert.deepEqual(fixture.events, ["stop-scope", "stop-service", "remove-home"]);
  assert(failure instanceof AggregateError);
  assert.equal(failure.cause, primary);
  assert.deepEqual(failure.errors, [primary, stopFailure, stopFailure, removeFailure]);
});

for (const stage of ["available-port", "setup"]) {
  test(`${stage} failure removes the already-created temporary home`, async (t) => {
    let home;
    const primary = new Error(`synthetic ${stage} failure`);
    const options = {
      createHome: async () => {
        home = await mkdtemp(path.join(tmpdir(), "html-inbox-cleanup-regression-"));
        return home;
      },
      findPort: async () => {
        if (stage === "available-port") throw primary;
        return 12345;
      },
      stopUnit: async () => { assert.fail("No owner was launched, so no units need stopping"); },
    };
    t.after(async () => {
      if (home) await rm(home, { recursive: true, force: true });
    });

    const failure = await captureFailure(withViewerSystemdFixture(true, () => { throw primary; }, options));

    assert.equal(failure, primary);
    await assert.rejects(access(home), { code: "ENOENT" });
  });
}

test("directory cleanup failure retains a setup error without a launched owner", async () => {
  const fixture = recordingFixture();
  const primary = new Error("synthetic setup failure");
  const removeFailure = new Error("synthetic removal failure");
  fixture.options.removeHome = async () => { throw removeFailure; };

  const failure = await captureFailure(withViewerSystemdFixture(false, () => { throw primary; }, fixture.options));

  assert(failure instanceof AggregateError);
  assert.equal(failure.cause, primary);
  assert.deepEqual(failure.errors, [primary, removeFailure]);
});

test("cleanup failures fail an otherwise successful probe", async () => {
  const fixture = recordingFixture();
  const ownerFailure = new Error("synthetic owner failure");

  const failure = await captureFailure(withViewerSystemdFixture(false, ({ watchOwner }) => {
    const owner = new EventEmitter();
    watchOwner(owner);
    owner.emit("error", ownerFailure);
  }, fixture.options));

  assert(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [ownerFailure]);
  assert.deepEqual(fixture.events, ["stop-scope", "remove-home"]);
});

test("an owner that never exits cannot prevent directory cleanup", async () => {
  const fixture = recordingFixture();
  fixture.options.ownerExitTimeoutMs = 5;
  const probe = withViewerSystemdFixture(false, ({ watchOwner }) => {
    watchOwner(new EventEmitter());
  }, fixture.options);
  const deadline = new AbortController();
  let failure;
  try {
    failure = await captureFailure(Promise.race([
      probe,
      delay(100, undefined, { signal: deadline.signal }).then(() => { throw new Error("Regression deadline exceeded"); }),
    ]));
  } finally {
    deadline.abort();
  }

  assert(failure instanceof AggregateError);
  assert.match(failure.errors[0].message, /owner.*exit.*timed out/i);
  assert.deepEqual(fixture.events, ["stop-scope", "remove-home"]);
});

test("successful probes clean up their owned units and home", async () => {
  const fixture = recordingFixture();

  await withViewerSystemdFixture(true, ({ watchOwner, environment, home }) => {
    assert.equal(environment.HTML_INBOX_HOME, home);
    assert.equal(environment.HTML_INBOX_PORT, "12345");
    const owner = new EventEmitter();
    watchOwner(owner);
    owner.emit("exit", 0, null);
  }, fixture.options);

  assert.deepEqual(fixture.events, ["stop-scope", "stop-service", "remove-home"]);
});

function recordingFixture() {
  const events = [];
  const options = {
    createHome: async () => "synthetic-home",
    findPort: async () => 12345,
    stopUnit: async (unit) => { events.push(unit.endsWith(".scope") ? "stop-scope" : "stop-service"); },
    removeHome: async () => { events.push("remove-home"); },
  };

  return { events, options };
}

async function captureFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  assert.fail("Expected the fixture to reject");
}
