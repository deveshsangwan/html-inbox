import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadPublishInput } from "./publish-input";
import { temporaryHome } from "./test-fixtures";

test("publish input validation", async (t) => {
  const inputHome = await temporaryHome(t);
  const inputPath = path.join(inputHome, "report.html");
  const inputHtml = "<!doctype html><html><body>bounded</body></html>";
  await writeFile(inputPath, inputHtml);
  await assert.rejects(
    loadPublishInput(
      { filePath: inputPath, title: "Report", type: "report" },
      { HTML_INBOX_MAX_BYTES: "8" },
    ),
    /limit of 8 bytes/,
  );
  await assert.rejects(
    loadPublishInput(
      { filePath: inputPath, title: " ", type: "report" },
      { HTML_INBOX_MAX_BYTES: "1024" },
    ),
    /title must not be empty/,
  );

  // A clean document publishes with no advisory output.
  const cleanLoad = await loadPublishInput(
    { filePath: inputPath, title: "Report", type: "report" },
    { HTML_INBOX_MAX_BYTES: "1024" },
  );
  assert.deepEqual(cleanLoad.warnings, []);
  assert.equal(cleanLoad.input.title, "Report");

  // Lint findings surface without blocking the publish.
  const lintPath = path.join(inputHome, "lint.html");
  await writeFile(
    lintPath,
    '<!doctype html><html><body><img src="https://example.com/a.png"></body></html>',
  );
  const lintLoad = await loadPublishInput({
    filePath: lintPath,
    title: "Lint",
    type: "report",
  });
  assert.ok(lintLoad.warnings.length > 0);

  // Security-boundary findings still refuse the publish.
  const unsafePath = path.join(inputHome, "unsafe.html");
  await writeFile(
    unsafePath,
    '<!doctype html><html><body><a title=">" href="javascript:alert(1)">x</a></body></html>',
  );
  await assert.rejects(
    loadPublishInput({ filePath: unsafePath, title: "Unsafe", type: "report" }),
    /HTML validation failed/,
  );
});
