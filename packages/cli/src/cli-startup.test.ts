import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseCommand } from "./cli-args";
import { getCliVersion, USAGE } from "./index";

const executeFile = promisify(execFile);

test("entry dispatch preserves parser output and errors around help/version", async () => {
  const invocations = [
    [], ["--help"], ["-h"], ["--version"], ["-v"],
    ["--help", "--"], ["--version", "--"], ["--", "--help"],
    ["--help", "extra"], ["--version", "extra"], ["--help", "--json"],
    ["--version", "--home", "/tmp/inbox"], ["--inbox=x", "--help"],
    ["--help", "--home"], ["--version", "--version"], ["unknown"],
    ["__delete-document"],
  ];

  for (const args of invocations) {
    let expectedOutput: string;
    let expectedError = "";
    let expectedCode = 0;

    try {
      const parsed = parseCommand(args);
      assert.ok(parsed.command === "help" || parsed.command === "version");
      expectedOutput = `${parsed.command === "help" ? USAGE : getCliVersion()}\n`;
    } catch (error) {
      expectedOutput = "";
      expectedError = `html-inbox: ${error instanceof Error ? error.message : String(error)}\n`;
      expectedCode = 1;
    }

    const result = await executeFile(process.execPath, [path.join(__dirname, "index.js"), ...args])
      .then((output) => ({ ...output, code: 0 }), (error: unknown) => {
        if (!(error instanceof Error) || !("stdout" in error) || !("stderr" in error) || !("code" in error)) {
          throw error;
        }

        return { stdout: error.stdout, stderr: error.stderr, code: error.code };
      });

    assert.equal(result.code, expectedCode, JSON.stringify(args));
    assert.equal(result.stdout, expectedOutput, JSON.stringify(args));
    assert.equal(result.stderr, expectedError, JSON.stringify(args));
  }
});
