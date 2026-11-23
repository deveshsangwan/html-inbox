import { appendFileSync } from "node:fs";
import { test } from "node:test";
const log = process.env.FIFO_PROBE_LOG;
test("after-hook order", (t) => {
  t.after(() => appendFileSync(log, "first-registered\n"));
  t.after(() => appendFileSync(log, "second-registered\n"));
});
