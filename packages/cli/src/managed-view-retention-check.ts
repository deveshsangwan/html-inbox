import platformTest from "node:test";
import { runManagedViewProbe } from "./managed-view-probe-fixture";

// Explicit POSIX CI invocation; GC flags stay out of the ordinary unit runner.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

test("managed read-view retained state is disposed under explicit GC", { timeout: 75_000 }, async (t) => {
  await runManagedViewProbe(t, "retention");
});
