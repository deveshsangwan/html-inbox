import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports, createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createBrowserFixture } from "./browser-fixtures.mjs";

const require = createRequire(import.meta.url);
const records = require("../packages/cli/dist/viewer-records.js");
const browserType = {
  launch: async () => ({
    close: async () => {},
    newContext: async () => ({ newPage: async () => ({ setDefaultTimeout() {} }) }),
  }),
};

test("local fixture joins owned record cleanup before removing its root", async (t) => {
  let teardown;
  const fixture = await createBrowserFixture({ after: (callback) => { teardown = callback; } }, "local", async () => [], { browserType });
  const root = path.dirname(fixture.home);
  const entered = gate();
  const release = gate();
  const remove = records.removeViewerRecord;
  const rm = fs.rm;
  let hasCompletedCleanup = false;
  let hasStartedRootRemoval = false;
  t.mock.method(records, "removeViewerRecord", async (...args) => {
    entered.release();
    await release.promise;
    await remove(...args);
    hasCompletedCleanup = true;
  });
  t.mock.method(fs, "rm", async (target, options) => {
    if (target === root) {
      hasStartedRootRemoval = true;
      assert.equal(hasCompletedCleanup, true, "fixture root removal started before owned record cleanup completed");
    }

    return rm(target, options);
  });
  syncBuiltinESMExports();
  const closing = teardown();
  // Observe rejection immediately, including on the unfixed parent.
  const outcome = closing.then(() => undefined, (error) => error);

  try {
    await entered.promise;
    // Drain callbacks from native listener close while record cleanup is gated.
    await setImmediate();
    assert.equal(hasStartedRootRemoval, false, "fixture root removal started while owned cleanup was gated");
    assert(await records.readViewerRecord(fixture.home));
    release.release();
    await closing;
    assert.equal(hasCompletedCleanup, true);
    assert.equal(hasStartedRootRemoval, true);
    await assert.rejects(fs.stat(root), { code: "ENOENT" });
  } finally {
    release.release();
    await outcome;
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

for (const hasBrowserFailure of [false, true]) {
  test(`fixture retains shutdown evidence and propagates failures with browser failure ${hasBrowserFailure}`, async (t) => {
    let teardown;
    const browserError = new Error("browser close failed");
    const failingBrowser = {
      launch: async () => ({
        ...await browserType.launch(),
        close: async () => { if (hasBrowserFailure) throw browserError; },
      }),
    };
    const fixture = await createBrowserFixture({ after: (callback) => { teardown = callback; } }, "local", async () => [], { browserType: failingBrowser });
    const root = path.dirname(fixture.home);
    const cleanupError = new Error("owned record cleanup failed");
    const previousExitCode = process.exitCode;
    t.mock.method(records, "removeViewerRecord", async () => { throw cleanupError; });

    try {
      await assert.rejects(teardown(), (error) => {
        assert(error instanceof AggregateError);
        assert(error.message.includes(root));
        assert.deepEqual(error.errors, hasBrowserFailure ? [browserError, cleanupError] : [cleanupError]);
        return true;
      });
      assert((await fs.stat(root)).isDirectory());
      assert.equal((await records.readViewerRecord(fixture.home)).shutdownError, cleanupError.message);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
      t.mock.restoreAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const mode of ["local", "static"]) {
  test(`${mode} fixture still cleans up after browser close rejects`, async () => {
    let teardown;
    const browserError = new Error("browser close failed");
    const fixture = await createBrowserFixture({ after: (callback) => { teardown = callback; } }, mode, async () => [], {
      browserType: { launch: async () => ({ ...await browserType.launch(), close: async () => { throw browserError; } }) },
    });
    await assert.rejects(teardown(), (error) => error === browserError);
    await assert.rejects(fs.stat(path.dirname(fixture.home)), { code: "ENOENT" });
  });
}

test("failed viewer startup joins rollback reporting and retains fixture evidence", { timeout: 5000 }, async (t) => {
  let teardown;
  let home;
  let hasFailedRollback = false;
  let hasSettledStartup = false;
  let hasFinishedReporting = false;
  const startupError = new Error("viewer configuration failed");
  const rollbackError = new Error("startup record rollback failed");
  const reportingEntered = gate();
  const releaseReporting = gate();
  const reportingFinished = gate();
  const readRecord = records.readViewerRecord;
  const previousExitCode = process.exitCode;
  t.mock.method(records, "saveViewerConfiguration", async (selectedHome) => {
    home = selectedHome;
    throw startupError;
  });
  t.mock.method(records, "removeViewerRecord", async () => {
    hasFailedRollback = true;
    throw rollbackError;
  });
  const reporting = t.mock.method(records, "readViewerRecord", async (...args) => {
    if (hasFailedRollback) {
      reportingEntered.release();
      await releaseReporting.promise;
    }

    try {
      return await readRecord(...args);
    } finally {
      if (hasFailedRollback) {
        hasFinishedReporting = true;
        reportingFinished.release();
      }
    }
  });
  const startup = createBrowserFixture({ after: (callback) => { teardown = callback; } }, "local", async () => [], { browserType })
    .then(() => {
      hasSettledStartup = true;
      return undefined;
    }, (error) => {
      hasSettledStartup = true;
      return error;
    });

  try {
    await reportingEntered.promise;
    await setImmediate();
    assert.equal(hasSettledStartup, false, "startup rejection escaped before rollback reporting settled");
    const root = path.dirname(home);
    assert((await fs.stat(root)).isDirectory());
    releaseReporting.release();
    const failure = await startup;
    assert(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [startupError, rollbackError]);
    assert.equal(hasFinishedReporting, true);
    const reportingCalls = reporting.mock.callCount();
    await assert.rejects(teardown(), (error) => {
      assert(error instanceof AggregateError);
      assert(error.message.includes(root));
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
    assert((await fs.stat(root)).isDirectory());
    await setImmediate();
    assert.equal(reporting.mock.callCount(), reportingCalls);
  } finally {
    releaseReporting.release();
    await startup;
    await reportingFinished.promise;
    process.exitCode = previousExitCode;
    t.mock.restoreAll();
    if (home) await fs.rm(path.dirname(home), { recursive: true, force: true });
  }
});

for (const mode of ["local", "static"]) {
  test(`${mode} fixture preserves browser and root-removal failures`, async (t) => {
    let teardown;
    const browserError = new Error("browser close failed");
    const removalError = new Error("fixture root removal failed");
    const fixture = await createBrowserFixture({ after: (callback) => { teardown = callback; } }, mode, async () => [], {
      browserType: { launch: async () => ({ ...await browserType.launch(), close: async () => { throw browserError; } }) },
    });
    const root = path.dirname(fixture.home);
    const rm = fs.rm;
    t.mock.method(fs, "rm", async (target, options) => {
      if (target === root) throw removalError;
      return rm(target, options);
    });
    syncBuiltinESMExports();

    try {
      await assert.rejects(teardown(), (error) => {
        assert(error instanceof AggregateError);
        assert(error.message.includes(root));
        assert.deepEqual(error.errors, [browserError, removalError]);
        return true;
      });
      assert((await fs.stat(root)).isDirectory());
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}
