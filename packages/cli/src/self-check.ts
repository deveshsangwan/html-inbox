import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalDocumentBackend } from "./backend";
import { startViewer } from "./viewer";

async function run(): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "html-inbox-"));
  const backend = new LocalDocumentBackend(home);
  const html = "<!doctype html><html><body><h1>Report</h1></body></html>";
  const published = await backend.publish({
    html,
    originalBytes: Buffer.from(html),
    title: "Report",
    type: "report",
    sourceFileName: "report.html",
  });

  const stored = await readFile(
    path.join(home, "documents", published.metadata.id, "index.html"),
    "utf8",
  );
  assert.equal(stored, html);

  const server = await startViewer(backend, home, 0);
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await fetch(`${baseUrl}/health`)).ok, true);
    const shell = await fetch(`${baseUrl}/documents/${published.metadata.id}`);
    assert.equal(shell.headers.get("content-security-policy")?.includes("frame-src 'self'"), true);
    assert.equal((await shell.text()).includes("<iframe sandbox"), true);

    const content = await fetch(`${baseUrl}/documents/${published.metadata.id}/content`);
    assert.equal(content.headers.get("content-security-policy")?.includes("script-src 'none'"), true);
    assert.equal(await content.text(), html);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

void run();
