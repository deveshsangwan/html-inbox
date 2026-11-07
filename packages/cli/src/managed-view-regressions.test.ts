import platformTest from "node:test";
import { runManagedViewProbe } from "./managed-view-probe-fixture";

// One discovered file belongs to exactly one shard of each current runtime.
const test = process.platform === "win32" ? platformTest.skip : platformTest;

test("managed read-view actual controls run through normal unit discovery", { timeout: 75_000 }, async (t) => {
  await runManagedViewProbe(t, "actual-view");
});
