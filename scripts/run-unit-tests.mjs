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

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
