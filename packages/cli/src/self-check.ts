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
  const server = await startViewer(backend, home, 0);
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await fetch(`${baseUrl}/health`)).ok, true);

    const emptyIndex = await fetch(baseUrl);
    const emptyIndexCsp = emptyIndex.headers.get("content-security-policy") ?? "";
    const emptyIndexHtml = await emptyIndex.text();
    assert.equal(emptyIndexHtml.includes('class="empty-state"'), true);
    assert.equal(emptyIndexHtml.includes("No documents yet"), true);
    assert.equal(emptyIndexHtml.includes("0 documents"), true);

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

    const singularIndex = await fetch(baseUrl);
    const indexCsp = singularIndex.headers.get("content-security-policy") ?? "";
    assert.equal(indexCsp.includes("script-src 'self'"), true);
    assert.equal(indexCsp.includes("style-src 'self'"), true);
    assert.equal(indexCsp.includes("'unsafe-inline'"), false);
    assert.equal(emptyIndexCsp, indexCsp);
    const singularIndexHtml = await singularIndex.text();
    assert.equal(singularIndexHtml.includes('class="document-list"'), true);
    assert.equal(singularIndexHtml.includes("report.html"), true);
    assert.equal(singularIndexHtml.includes('data-theme-selector'), true);
    assert.equal(singularIndexHtml.includes("1 document"), true);
    assert.equal(singularIndexHtml.includes("1 documents"), false);

    const stylesheet = await fetch(`${baseUrl}/assets/viewer.css`);
    assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
    const stylesheetText = await stylesheet.text();
    assert.equal(stylesheetText.includes('[data-theme="dark"]'), true);
    assert.equal(stylesheetText.includes("--muted: #5d655f"), true);
    assert.equal(stylesheetText.includes("--faint: #646c66"), true);

    const viewerScript = await fetch(`${baseUrl}/assets/viewer.js`);
    assert.equal(viewerScript.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await viewerScript.text()).includes("html-inbox-theme"), true);

    const shell = await fetch(`${baseUrl}/documents/${published.metadata.id}`);
    assert.equal(shell.headers.get("content-security-policy")?.includes("frame-src 'self'"), true);
    const shellHtml = await shell.text();
    assert.equal(shellHtml.includes('<iframe sandbox="allow-scripts"'), true);
    assert.equal(shellHtml.includes("allow-same-origin"), false);
    assert.equal(shellHtml.includes("report.html"), true);
    assert.equal(shellHtml.includes("Back to inbox"), true);

    const content = await fetch(`${baseUrl}/documents/${published.metadata.id}/content`);
    const csp = content.headers.get("content-security-policy") ?? "";
    assert.equal(csp.includes("script-src 'unsafe-inline' https://cdn.tailwindcss.com"), true);
    assert.equal(csp.includes("https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"), true);
    assert.equal(csp.includes("https://cdn.jsdelivr.net/npm/mermaid@11/dist/"), true);
    assert.equal(csp.includes("connect-src 'none'"), true);
    assert.equal(csp.includes("frame-src 'none'"), true);
    assert.equal(await content.text(), html);

    const hostileTitle = 'Title </h1><script>alert("title")</script>';
    const hostileType = "report\"><svg/onload=alert('type')>";
    const hostileSource = 'source.html\" autofocus onfocus="alert(\'source\')';
    const hostile = await backend.publish({
      html,
      originalBytes: Buffer.from(html),
      title: hostileTitle,
      type: hostileType,
      sourceFileName: hostileSource,
    });

    const pluralIndexHtml = await (await fetch(baseUrl)).text();
    assert.equal(pluralIndexHtml.includes("2 documents"), true);
    assert.equal(pluralIndexHtml.includes(hostileTitle), false);
    assert.equal(pluralIndexHtml.includes(hostileType), false);
    assert.equal(pluralIndexHtml.includes(hostileSource), false);
    assert.equal(
      pluralIndexHtml.includes(
        "Title &#60;/h1&#62;&#60;script&#62;alert(&#34;title&#34;)&#60;/script&#62;",
      ),
      true,
    );
    assert.equal(
      pluralIndexHtml.includes(
        "report&#34;&#62;&#60;svg/onload=alert(&#39;type&#39;)&#62;",
      ),
      true,
    );
    assert.equal(
      pluralIndexHtml.includes(
        "source.html&#34; autofocus onfocus=&#34;alert(&#39;source&#39;)",
      ),
      true,
    );

    const hostileShellHtml = await (
      await fetch(`${baseUrl}/documents/${hostile.metadata.id}`)
    ).text();
    assert.equal(hostileShellHtml.includes(hostileTitle), false);
    assert.equal(hostileShellHtml.includes(hostileType), false);
    assert.equal(hostileShellHtml.includes(hostileSource), false);
    assert.equal(hostileShellHtml.includes("&#60;/h1&#62;"), true);
    assert.equal(
      hostileShellHtml.includes(
        "report&#34;&#62;&#60;svg/onload=alert(&#39;type&#39;)&#62;",
      ),
      true,
    );
    assert.equal(
      hostileShellHtml.includes(
        "source.html&#34; autofocus onfocus=&#34;alert(&#39;source&#39;)",
      ),
      true,
    );
    assert.equal(hostileShellHtml.includes('onfocus="alert'), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

void run();
