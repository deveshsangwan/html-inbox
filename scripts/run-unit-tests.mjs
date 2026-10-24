import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = new URL("../packages/cli/dist/", import.meta.url);
const files = (await readdir(directory, { recursive: true }))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => fileURLToPath(new URL(name, directory)));

if (files.length === 0) {
  throw new Error("No compiled tests found. Run the build first.");
}

// TAP emits each failure immediately, even when another test later holds the process open.
const reporter = process.env.GITHUB_ACTIONS === "true" ? ["--test-reporter=tap"] : [];
const child = spawn(process.execPath, ["--test", ...reporter, ...files], { stdio: "inherit" });
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
