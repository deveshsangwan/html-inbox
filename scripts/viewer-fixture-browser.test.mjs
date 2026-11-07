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
