import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const browserTestDirectory = new URL("./", import.meta.url);
const browserTestFiles = (await readdir(browserTestDirectory))
  .filter((name) => name.endsWith("-browser.test.mjs"))
  .sort()
  .map((name) => fileURLToPath(new URL(name, browserTestDirectory)));

if (browserTestFiles.length === 0) {
  throw new Error("No browser test suites found.");
}

// Pass concrete paths because Windows cmd does not expand shell globs.
const testProcess = spawn(process.execPath, ["--test", ...browserTestFiles], { stdio: "inherit" });
testProcess.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
testProcess.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
