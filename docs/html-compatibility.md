# HTML compatibility

HTML Inbox stores the original HTML file. Files beside it, such as `chart.png`,
`styles.css`, and `app.js`, are not copied into the inbox. The document Content
Security Policy blocks those resources in source viewers, local hubs, and served
static snapshots.

Publishing continues when validation reports a compatibility warning. A warning
means some content may not render or run. Fix the source HTML and publish it again.

## Keep resources in the document

| Resource | Use instead of a relative file URL |
| --- | --- |
| Images, video, audio, and video posters | Embed the bytes in a `data:` URL. |
| Images in `srcset` | Embed every candidate as a `data:` URL, or use one embedded image in `src`. |
| Stylesheets | Put CSS in a `<style>` element. |
| JavaScript | Put code in an inline `<script>`, or use a supported CDN entry URL below. |
| SVG symbols | Put the symbol in the document and reference its ID with `<use href="#symbol">`. |

For example, `<img src="chart.png">`, `<script src="app.js">`, and
`<link rel="stylesheet" href="styles.css">` produce advisory warnings. Asset
paths starting with `./`, `../`, or `/` are blocked too. A mixed `srcset` such as
`data:image/png;base64,... 1x, chart.png 2x` still has a blocked candidate.

Frames and objects remain blocked by the CSP. Embedding their content as a
`data:` URL does not make them supported. Inline event handlers such as `onclick`
are also blocked; attach handlers from an inline script instead.

## Supported script entry URLs

- `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4`
- `https://cdn.tailwindcss.com`, including its supported `?plugins=` query
- `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs`

Use the Mermaid entry URL in a module script or an inline module import. Other
remote script entry URLs produce advisory warnings. URLs outside the document
CSP's script sources are blocked, but those sources include the Mermaid `dist/`
subtree for module chunks and the Tailwind CDN origin. A noncanonical script URL
inside those sources can warn and still load. External images and stylesheets
remain blocked even when their host serves a supported script.

## Navigation and local references

Relative links and fragment links in `<a href>` and `<area href>` remain allowed,
as do HTTPS navigation links. They do not load an asset. A relative link resolves
against the stored document URL, so it does not provide access to files that were
beside the source HTML.

An SVG `<use href="#symbol">` or `<use xlink:href="#symbol">` references an
element in the current document and produces no relative-asset warning.

Validation checks URL attributes in parsed markup. It does not inspect CSS
`url()` or `@import`, or reliably detect resource URLs assembled by JavaScript.
Those requests remain subject to the document CSP. Validation is a compatibility
check, not a sanitizer; see the [threat model](threat-model.md).

## Saved text and code copying

The 0.4.0 reader extracts saved body text and numbered `<pre>` blocks without executing author code. Inline `<code>` alone is not a numbered block. Saved Mermaid `<pre>` content can be copied as diagram source; interactive changes, CSS visibility, and rendered visuals are not reconstructed. Native selection in the preview uses the browser's Copy command. See [copying saved content](architecture.md#copying-saved-content).
