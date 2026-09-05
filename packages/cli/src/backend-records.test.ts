import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import { assertExportOutsideHome, formatDocumentList } from "./index";
import { startViewer } from "./viewer-server";
import { temporaryHome, availablePort } from "./test-fixtures";

test(
  "private storage and path overlap",
  {
    skip:
      process.platform === "win32"
        ? "POSIX symlink and file-permission checks"
        : false,
  },
  async (t) => {
    const overlapRoot = await temporaryHome(t);
    const realHome = path.join(overlapRoot, "home");
    const homeAlias = path.join(overlapRoot, "home-alias");
    await mkdir(realHome);
    await symlink(realHome, homeAlias);
    assert.throws(
      () => assertExportOutsideHome(path.join(homeAlias, "export"), realHome),
      /must not contain or be inside/,
    );
    const differentlyCasedHome = path.join(overlapRoot, "HOME");
    try {
      await stat(differentlyCasedHome);
      assert.throws(
        () =>
          assertExportOutsideHome(
            path.join(differentlyCasedHome, "export"),
            realHome,
          ),
        /must not contain or be inside/,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const unsafeHome = await temporaryHome(t);
    const symlinkTarget = path.join(unsafeHome, "target.txt");
    await writeFile(symlinkTarget, "do not overwrite");
    await symlink(symlinkTarget, path.join(unsafeHome, "instance-id"));
    await assert.rejects(
      startViewer(new LocalDocumentBackend(unsafeHome), unsafeHome, 0),
      /Managed file is not a regular file/,
    );
    assert.equal(await readFile(symlinkTarget, "utf8"), "do not overwrite");
  },
);
test("failed storage and viewer startup roll back", async (t) => {
  const home = await temporaryHome(t);
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(home, (warning) =>
    warnings.push(warning),
  );
  assert.equal(await backend.getDocument("missing"), null);
  assert.equal(warnings.length, 0);
  await assert.rejects(
    stat(path.join(home, "documents", "missing")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

  const failedViewerHome = await temporaryHome(t);
  await mkdir(path.join(failedViewerHome, "viewer.json"));
  const failedViewerPort = await availablePort();
  await assert.rejects(
    startViewer(
      new LocalDocumentBackend(failedViewerHome),
      failedViewerHome,
      failedViewerPort,
    ),
    /Managed file is not a regular file/,
  );
  await assertPortAvailable(failedViewerPort);

  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const failedPublishId = "failed-publish";
  const failedStagingDir = path.join(
    home,
    "documents",
    ".staging",
    failedPublishId,
  );
  await mkdir(path.join(failedStagingDir, "metadata.json"), {
    recursive: true,
  });
  const failedBackend = new LocalDocumentBackend(
    home,
    (warning) => warnings.push(warning),
    () => failedPublishId,
  );
  await assert.rejects(
    failedBackend.publish({
      originalBytes: Buffer.from(html),
      title: "Failed report",
      type: "report",
      sourceFileName: "failed.html",
    }),
    /Managed file is not a regular file/,
  );
  await assert.rejects(
    stat(failedStagingDir),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  await assert.rejects(
    stat(path.join(home, "documents", failedPublishId)),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});
test("corrupt records are skipped and CLI deletion requires force", async (t) => {
  const home = await temporaryHome(t);
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(home, (warning) =>
    warnings.push(warning),
  );
  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const published = await backend.publish({
    originalBytes: Buffer.from(html),
    title: "Report",
    type: "report",
    sourceFileName: "report.html",
  });
  const hostileTitle = 'Title </h1><script>alert("title")</script>';
  const hostileType = "report\"><svg/onload=alert('type')>";
  const hostileSource = "source.html\" autofocus onfocus=\"alert('source')";
  const hostile = await backend.publish({
    originalBytes: Buffer.from(html),
    title: hostileTitle,
    type: hostileType,
    sourceFileName: hostileSource,
  });

  const corruptId = "corrupt-record";
  const corruptDir = path.join(home, "documents", corruptId);
  await mkdir(corruptDir);
  await writeFile(path.join(corruptDir, "index.html"), html);
  await writeFile(path.join(corruptDir, "metadata.json"), "{not-json");

  const mismatchedId = "mismatched-record";
  const mismatchedDir = path.join(home, "documents", mismatchedId);
  await mkdir(mismatchedDir);
  await writeFile(path.join(mismatchedDir, "index.html"), html);
  await writeFile(
    path.join(mismatchedDir, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "different-id",
      title: "Mismatched report",
      type: "report",
      createdAt: "2026-07-16T00:00:00.000Z",
      sourceFileName: "mismatched.html",
    }),
  );

  const incompleteId = "incomplete-record";
  const incompleteDir = path.join(home, "documents", incompleteId);
  await mkdir(incompleteDir);
  await writeFile(
    path.join(incompleteDir, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: incompleteId,
      title: "Incomplete report",
      type: "report",
      createdAt: "2026-07-16T00:00:00.000Z",
      sourceFileName: "incomplete.html",
    }),
  );

  const warningCount = warnings.length;
  assert.equal(await backend.getDocument(incompleteId), null);
  assert.equal(
    warnings
      .slice(warningCount)
      .some((warning) => warning.includes(incompleteId)),
    true,
  );

  const documentsAfterCorruption = await backend.listDocuments();
  assert.equal(documentsAfterCorruption.length, 2);
  assert.equal(await backend.getDocument(corruptId), null);
  assert.equal(
    warnings.some((warning) => warning.includes(corruptId)),
    true,
  );
  assert.equal(
    warnings.some((warning) => warning.includes(mismatchedId)),
    true,
  );
  assert.equal(
    warnings.some((warning) => warning.includes(incompleteId)),
    true,
  );

  const textList = formatDocumentList(documentsAfterCorruption, false);
  assert.equal(textList.includes(published.id), true);
  assert.equal(
    JSON.parse(formatDocumentList(documentsAfterCorruption, true)).length,
    2,
  );

  const cliEnv = { ...process.env, HTML_INBOX_HOME: home };
  const listed = spawnSync(
    process.execPath,
    [path.join(__dirname, "index.js"), "list", "--json"],
    { env: cliEnv, encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 2);

  const refusedDelete = spawnSync(
    process.execPath,
    [path.join(__dirname, "index.js"), "delete", hostile.id],
    { env: cliEnv, encoding: "utf8" },
  );
  assert.notEqual(refusedDelete.status, 0);
  assert.match(refusedDelete.stderr, /requires --force/);

  const forcedDelete = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "index.js"),
      "delete",
      hostile.id,
      "--force",
      "--json",
    ],
    { env: cliEnv, encoding: "utf8" },
  );
  assert.equal(forcedDelete.status, 0, forcedDelete.stderr);
  assert.equal(JSON.parse(forcedDelete.stdout).metadata.id, hostile.id);
  assert.equal(await backend.getDocument(hostile.id), null);
  assert.equal((await backend.listDocuments()).length, 1);
});
async function assertPortAvailable(port: number): Promise<void> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
