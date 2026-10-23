import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractDocumentCopyContent, MAX_DOCUMENT_COPY_JSON_BYTES } from "./document-copy";

test("copy text keeps body structure, Unicode, links, and once-decoded entities", () => {
  const html = `<!doctype html><html><head><title>Metadata title</title></head><body>
    <h1> A   heading </h1>
    <p>Hello <strong>bold</strong>\t <a href="https://example.test">link</a>.<br>Next<br><br>line</p>
    <ul><li>First<ul><li>Nested</li></ul></li><li>Second</li></ul>
    <table><tr><th>Name</th><th>Value</th></tr><tr><td>π 😀</td><td>&lt;tag&gt; &amp;amp; A&nbsp;B</td></tr></table>
    <p>مرحبا</p>
  </body></html>`;

  assert.deepEqual(extractDocumentCopyContent(Buffer.from(html)), {
    schemaVersion: 1,
    status: "ready",
    text: "A heading\nHello bold link.\nNext\n\nline\nFirst\nNested\nSecond\nName\tValue\nπ 😀\t<tag> &amp; A\u00a0B\nمرحبا",
    codeBlocks: [],
  });
});

for (const { name, rows, text } of [
  {
    name: "an empty numeric column under its header",
    rows: "<tr><th>Name</th><th>Q1</th><th>Q2</th></tr><tr><td>Sales</td><td></td><td>100</td></tr>",
    text: "Name\tQ1\tQ2\nSales\t\t100",
  },
  {
    name: "leading, middle, and trailing empty cells",
    rows: "<tr><td></td><td>B</td><td></td></tr><tr><td>A</td><td></td><td>C</td></tr><tr><td>A</td><td>B</td><td></td></tr>",
    text: "\tB\t\nA\t\tC\nA\tB\t",
  },
  {
    name: "consecutive empty cells and formatting whitespace",
    rows: "<tr>\n  <td> </td>\n  <td></td><td></td><td> D </td>\n  <td></td><td> </td>\n</tr>",
    text: "\t\t\tD\t\t",
  },
  {
    name: "leading and middle empty single-column rows",
    rows: "<tr><td></td></tr><tr><td>B</td></tr><tr><td></td></tr><tr><td>D</td></tr>",
    text: "\nB\n\nD",
  },
  {
    name: "consecutive trailing empty single-column rows",
    rows: "<tr><td>A</td></tr><tr><td></td></tr><tr><td></td></tr>",
    text: "A\n\n",
  },
  {
    name: "all-empty single-column rows",
    rows: "<tr><td></td></tr><tr><td></td></tr>",
    text: "\n",
  },
  {
    name: "paragraph-wrapped cells",
    rows: "<tr><td><p>A</p></td><td><p>B</p></td></tr>",
    text: "A\tB",
  },
  {
    name: "nested block wrappers and leading empty paragraphs",
    rows: "<tr><td><div><p></p><p>A</p></div></td><td><div><p>B</p></div></td></tr>",
    text: "A\tB",
  },
  {
    name: "empty block-wrapped cells across rows",
    rows: "<tr><td><p></p></td><td><div>B</div></td><td><p></p></td></tr><tr><td><p>C</p></td><td><div></div></td><td><p>D</p></td></tr>",
    text: "\tB\t\nC\t\tD",
  },
  {
    name: "multiple paragraphs within each cell",
    rows: "<tr><td><p>A</p><p>B</p></td><td><div>C</div><div>D</div></td></tr>",
    text: "A\nB\tC\nD",
  },
  {
    name: "a paragraph after code ending in a literal tab",
    rows: "<tr><td><code>code&#9;</code><p>after</p></td><td><div>next</div></td></tr>",
    text: "code\t\nafter\tnext",
  },
]) {
  test(`copy text preserves table delimiters for ${name}`, () => {
    assert.deepEqual(extractDocumentCopyContent(Buffer.from(`<table>${rows}</table>`)), {
      schemaVersion: 1, status: "ready", text, codeBlocks: [],
    });
  });
}

test("ordinary whitespace after explicit line breaks does not indent text", () => {
  const html = "<body>A<br>\n  B<br><span> C</span><pre><code>  x\n  y  </code></pre></body>";

  assert.deepEqual(extractDocumentCopyContent(Buffer.from(html)), {
    schemaVersion: 1,
    status: "ready",
    text: "A\nB\nC\n  x\n  y  ",
    codeBlocks: ["  x\n  y  "],
  });
});

test("copy text omits non-content and explicitly hidden subtrees without executing markup", () => {
  const html = `<!doctype html><html><head><title>private title</title><style>private style</style></head><body>
    <script>throw new Error("must not execute")</script><style>private CSS</style>
    <template><p>template text</p><pre>template code</pre></template>
    <noscript>noscript text</noscript><!-- comment text -->
    <div hidden="false">hidden text<pre>hidden code</pre></div><div hidden="until-found">hidden too</div>
    <p onclick="throw 1">Saved &lt;/textarea&gt; &lt;script&gt; text</p>
    <svg><text>SVG label</text><script>private SVG script</script></svg>
    <iframe src="https://example.test" srcdoc="private frame">fallback text</iframe>
    <img src="https://example.test/image" alt="not synthesized"><input value="not synthesized">
    <form><button>Author button</button></form>
  </body></html>`;

  assert.deepEqual(extractDocumentCopyContent(Buffer.from(html)), {
    schemaVersion: 1,
    status: "ready",
    text: "Saved </textarea> <script> text\nSVG label fallback text\nAuthor button",
    codeBlocks: [],
  });
});

test("copy extraction follows HTML5 recovery and does not infer CSS visibility or runtime text", () => {
  const html = '<html><body><p>First<p>Second &amp;amp;<ul><li>A<li>B</ul><div style="display:none">CSS-hidden text</div><script>document.body.append("Runtime text")</script>';

  assert.deepEqual(extractDocumentCopyContent(Buffer.from(html)), {
    schemaVersion: 1,
    status: "ready",
    text: "First\nSecond &amp;\nA\nB\nCSS-hidden text",
    codeBlocks: [],
  });
});

test("preformatted blocks preserve indentation, tabs, blank lines, trailing whitespace, and document order", () => {
  const html = '<html><body><p>Before</p><pre><code>\r\n\t<span>const</span> value = &lt;tag&gt;;  \r\n\r\n  end\t \r\n</code></pre><p>Between</p><pre>\n  bare\t\n\n </pre><pre></pre><p>After</p></body></html>';
  const firstBlock = "\n\tconst value = <tag>;  \n\n  end\t \n";
  // HTML parsing removes the first line feed immediately inside a bare pre element.
  const secondBlock = "  bare\t\n\n ";

  assert.deepEqual(extractDocumentCopyContent(Buffer.from(html)), {
    schemaVersion: 1,
    status: "ready",
    text: `Before\n${firstBlock}Between\n${secondBlock}\nAfter`,
    codeBlocks: [firstBlock, secondBlock, ""],
  });
});

test("code blocks do not double count nested pre/code, and hidden code stays omitted", () => {
  const html = '<body><pre>outer<code><span>\tinner  </span><code>nested\n</code></code><pre>bare</pre><span hidden>secret</span><script>secret</script><br>end  </pre></body>';

  assert.deepEqual(extractDocumentCopyContent(Buffer.from(html)), {
    schemaVersion: 1,
    status: "ready",
    text: "outer\tinner  nested\nbare\nend  ",
    codeBlocks: ["outer\tinner  nested\nbare\nend  "],
  });
});

test("inline code keeps its whitespace without becoming a separate code block", () => {
  assert.deepEqual(extractDocumentCopyContent(Buffer.from("<body>  A <code>\t x\n\n  </code> B <code>tail  </code>  </body>")), {
    schemaVersion: 1,
    status: "ready",
    text: "A \t x\n\n   B tail  ",
    codeBlocks: [],
  });
});

test("empty and hidden bodies return ready empty content", () => {
  for (const html of ["", "<body> \n\t </body>", "<html hidden><body>secret</body></html>", "<body hidden><pre>secret</pre></body>"]) {
    assert.deepEqual(extractDocumentCopyContent(Buffer.from(html)), {
      schemaVersion: 1, status: "ready", text: "", codeBlocks: [],
    });
  }
});

test("copy extraction rejects invalid UTF-8 and leaves original bytes intact", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe2, 0x82]), Buffer.from([0xed, 0xa0, 0x80])]) {
    const before = Buffer.from(bytes);

    assert.deepEqual(extractDocumentCopyContent(bytes), {
      schemaVersion: 1, status: "unavailable", reason: "invalid-encoding",
    });
    assert.deepEqual(bytes, before);
  }

  const bytes = Buffer.from("\ufeff<!doctype html>\r\n<body><pre>  π\r\n\t</pre></body>\r\n");
  const before = Buffer.from(bytes);
  const payload = extractDocumentCopyContent(bytes);

  assert.equal(payload.status, "ready");
  assert.deepEqual(bytes, before);
});

test("copy extraction checks the configured byte limit before decoding or parsing", () => {
  const bytes = Buffer.from([0xff, 0xff]);

  assert.deepEqual(extractDocumentCopyContent(bytes, 1), {
    schemaVersion: 1, status: "unavailable", reason: "too-large",
  });
  assert.deepEqual(extractDocumentCopyContent(Buffer.from("OK"), 2), {
    schemaVersion: 1, status: "ready", text: "OK", codeBlocks: [],
  });
});

test("copy JSON accepts exactly 10 MiB and returns unavailable above it without truncating", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, status: "ready", text: "", codeBlocks: [] }));
  const bytes = Buffer.alloc(MAX_DOCUMENT_COPY_JSON_BYTES - overhead, "a");
  const payload = extractDocumentCopyContent(bytes);

  assert.equal(payload.status, "ready");
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), MAX_DOCUMENT_COPY_JSON_BYTES);

  if (payload.status === "ready") {
    assert.equal(payload.text, bytes.toString());
  }

  assert.deepEqual(extractDocumentCopyContent(Buffer.concat([bytes, Buffer.from("a")])), {
    schemaVersion: 1, status: "unavailable", reason: "too-large",
  });
});

test("copy JSON includes empty table cell and row delimiters in its encoded byte limit", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, status: "ready", text: "", codeBlocks: [] }));
  const contentBytes = MAX_DOCUMENT_COPY_JSON_BYTES - overhead - 4;
  const text = '"'.repeat(Math.floor(contentBytes / 2)) + "x".repeat(contentBytes % 2);
  const html = `<table><tr><td>${text}</td><td></td></tr><tr><td></td></tr></table>`;
  const payload = extractDocumentCopyContent(Buffer.from(html));

  assert.deepEqual(payload, {
    schemaVersion: 1, status: "ready", text: `${text}\t\n`, codeBlocks: [],
  });
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), MAX_DOCUMENT_COPY_JSON_BYTES);
  assert.deepEqual(extractDocumentCopyContent(Buffer.from(html.replace("</table>", "<tr><td></td></tr></table>"))), {
    schemaVersion: 1, status: "unavailable", reason: "too-large",
  });
});

test("copy JSON accounts for escaping, UTF-8 bytes, and code duplicated in document text", () => {
  for (const text of ['"'.repeat(MAX_DOCUMENT_COPY_JSON_BYTES / 2), "π".repeat(MAX_DOCUMENT_COPY_JSON_BYTES / 2)]) {
    const bytes = Buffer.from(text);

    assert.deepEqual(extractDocumentCopyContent(bytes), {
      schemaVersion: 1, status: "unavailable", reason: "too-large",
    });
  }

  const bytes = Buffer.from(`<pre>${"x".repeat(MAX_DOCUMENT_COPY_JSON_BYTES / 2)}</pre>`);

  assert.deepEqual(extractDocumentCopyContent(bytes), {
    schemaVersion: 1, status: "unavailable", reason: "too-large",
  });
});

test("copy extraction handles wide and deeply nested documents without recursive traversal", () => {
  const depth = 12_000;
  const nested = `<body>${"<div>".repeat(depth)}Deep${"</div>".repeat(depth)}</body>`;
  const wide = `<body>${"<span>x</span>".repeat(100_000)}</body>`;

  assert.deepEqual(extractDocumentCopyContent(Buffer.from(nested)), {
    schemaVersion: 1, status: "ready", text: "Deep", codeBlocks: [],
  });
  assert.deepEqual(extractDocumentCopyContent(Buffer.from(wide)), {
    schemaVersion: 1, status: "ready", text: "x".repeat(100_000), codeBlocks: [],
  });
});
