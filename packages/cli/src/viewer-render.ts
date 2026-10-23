import { type DocumentMetadata } from "./documents";
import { type Appearance } from "./preferences";

export interface ViewerRenderOptions {
  appearance?: Appearance;
  basePath?: string;
  clientSearch?: boolean;
  timeZone?: string;
  inboxName?: string;
  homePath?: string;
  documentBasePath?: string;
}

export function renderIndex(
  allDocuments: DocumentMetadata[],
  query: string,
  options: ViewerRenderOptions = {},
): string {
  const basePath = options.basePath ?? "";
  const documents = allDocuments.map((metadata) => ({
    metadata,
    documentPath: `${basePath}/documents/${metadata.id}${basePath ? "/" : ""}`,
  }));

  return renderLibrary(documents, query, options);
}

export interface HubInboxListing {
  name: string;
  available: boolean;
  documents: DocumentMetadata[];
}

interface LibraryDocument {
  metadata: DocumentMetadata;
  documentPath: string;
  inboxName?: string;
}

export function renderHubIndex(
  sources: HubInboxListing[],
  query: string,
  inbox: string,
  options: ViewerRenderOptions = {},
): string {
  const documents = sources.flatMap((source) => source.documents.map((metadata) => ({
    metadata,
    inboxName: source.name,
    documentPath: `/sources/${source.name}/documents/${metadata.id}`,
  })));
  documents.sort((left, right) => right.metadata.createdAt.localeCompare(left.metadata.createdAt) ||
    left.inboxName.localeCompare(right.inboxName) || left.metadata.id.localeCompare(right.metadata.id));

  return renderLibrary(documents.filter((document) => !inbox || document.inboxName === inbox), query, options, { sources, inbox });
}

function renderLibrary(
  allDocuments: LibraryDocument[],
  query: string,
  options: ViewerRenderOptions,
  hub?: { sources: HubInboxListing[]; inbox: string },
): string {
  const basePath = options.basePath ?? "";
  const homePath = options.homePath ?? (basePath ? `${basePath}/` : "/");
  query = query.trim().slice(0, 200);
  const normalizedQuery = query.toLowerCase();
  const documents = normalizedQuery
    ? allDocuments.filter((document) =>
        [document.metadata.title, document.metadata.type, document.metadata.sourceFileName, ...(document.inboxName ? [document.inboxName] : [])]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : allDocuments;
  const hasUnavailableInboxes = hub?.sources.some((source) => !source.available) ?? false;
  const publishInbox = hub?.sources.find((source) => source.name === hub.inbox) ?? hub?.sources[0];
  const documentContent =
    documents.length === 0
      ? `<section class="empty-state" aria-labelledby="empty-title">
          <h2 id="empty-title">${hasUnavailableInboxes ? "No readable documents" : query ? "No matching documents" : "No documents yet"}</h2>
          <p>${
            query
              ? "Try another title, type, or source file name."
              : hasUnavailableInboxes
                ? "Retry when the selected inboxes are available."
                : hub
                  ? "Publish an HTML file to a selected inbox. It will appear here with its title, type, and source file."
                  : "Publish an HTML file from the CLI. It will appear here with its title, type, and source file."
          }</p>
          ${
            query || hasUnavailableInboxes
              ? ""
              : `<code>html-inbox publish ./document.html${publishInbox ? ` --inbox ${escapeHtml(publishInbox.name)}` : ""} --title "My document" --type report</code>`
          }
        </section>`
      : `<ol class="document-list" aria-label="Published documents">${documents
          .map(
            (document) =>
              `<li class="doc" data-search-text="${escapeHtml(
                [document.metadata.title, document.metadata.type, document.metadata.sourceFileName, ...(document.inboxName ? [document.inboxName] : [])]
                  .join(" ")
                  .toLowerCase(),
              )}">
                <a class="doc__title" href="${escapeHtml(document.documentPath)}">${escapeHtml(document.metadata.title)}${document.inboxName ? ` <span class="inbox-badge">${escapeHtml(document.inboxName)}</span>` : ""}</a>
                <time class="document-date" datetime="${escapeHtml(document.metadata.createdAt)}" data-local-date>${escapeHtml(formatDate(document.metadata.createdAt, options.timeZone))}</time>
                <span class="doc__source" title="${escapeHtml(document.metadata.sourceFileName)}">${escapeHtml(document.metadata.sourceFileName)}</span>
                <span class="document-type">${escapeHtml(document.metadata.type)}</span>
              </li>`,
          )
          .join("")}</ol>`;

  const countLabel = query
    ? `${documents.length} of ${allDocuments.length} documents`
    : `${documents.length} ${documents.length === 1 ? "document" : "documents"}`;

  return page(
    options.inboxName ? `${options.inboxName} | HTML Inbox` : "HTML Inbox",
    `<main class="library" id="main-content">
      <header class="library__bar">
        ${renderBrand(homePath)}
        <h1 class="library__title">${escapeHtml(options.inboxName ?? "Inbox")}</h1>
        <form class="search" role="search" method="get" action="${homePath}" ${options.clientSearch ? "data-client-search" : ""}>
          <label class="visually-hidden" for="document-search">Search documents</label>
          <div class="search__control">
            ${hub ? `${renderInboxFilter(hub.sources, hub.inbox)}\n            ` : ""}<input id="document-search" name="q" type="search" value="${escapeHtml(query)}" placeholder="Search title, type, or file" maxlength="200">
            <button class="search__button" type="submit" data-search-submit>Search</button>
            ${
              options.clientSearch
                ? `<a class="search__clear" href="${homePath}" data-search-clear${
                    query ? "" : " hidden"
                  }>Clear</a>`
                : query
                  ? `<a class="search__clear" href="${hub?.inbox ? `/?inbox=${encodeURIComponent(hub.inbox)}` : homePath}">Clear</a>`
                  : ""
            }
          </div>
        </form>
        ${renderAppearanceMenu()}
      </header>
      ${hub ? renderAvailability(hub.sources) : ""}<p class="document-count" aria-live="polite" data-document-count>${countLabel}</p>
      ${
        options.clientSearch && allDocuments.length > 0
          ? '<section class="empty-state" aria-labelledby="client-empty-title" data-client-empty hidden><h2 id="client-empty-title">No matching documents</h2><p>Try another title, type, or source file name.</p></section>'
          : ""
      }
      ${documentContent}
    </main>`,
    "Your published HTML documents, collected in one library.",
    basePath,
    options.appearance ?? "system",
    "inbox-page",
  );
}

export function renderDocumentShell(
  metadata: DocumentMetadata,
  options: ViewerRenderOptions = {},
): string {
  const basePath = options.basePath ?? "";
  const homePath = options.homePath ?? (basePath ? `${basePath}/` : "/");
  const documentBasePath = options.documentBasePath ?? basePath;
  const contentPath = documentBasePath
    ? `${documentBasePath}/documents/${escapeHtml(metadata.id)}/content${options.documentBasePath ? "" : "/"}`
    : `/documents/${escapeHtml(metadata.id)}/content`;

  return page(
    metadata.title,
    `<main class="document-view" id="main-content">
      <header class="reader__bar">
        <a class="back-link toolbar-control" href="${homePath}" aria-label="Back to inbox" title="Back to inbox"><span aria-hidden="true">&#8592;</span><span class="back-link__text">Back to inbox</span></a>
        <h1 class="document-title" title="${escapeHtml(metadata.title)}">${escapeHtml(metadata.title)}</h1>
        <button class="toolbar-control hide-frame" type="button" data-hide-frame>Hide frame</button>
        <details class="viewer-menu" data-viewer-menu>
          <summary class="toolbar-control" aria-label="Viewer options" title="Viewer options"><span aria-hidden="true">&#8943;</span></summary>
          <div class="viewer-menu__panel">
            ${renderAppearanceOptions()}
            <section class="document-details" aria-labelledby="document-details-title">
              <h2 id="document-details-title">Document details</h2>
              <dl>
                ${options.inboxName ? `<dt>Inbox</dt><dd>${escapeHtml(options.inboxName)}</dd>\n                ` : ""}<dt>Title</dt><dd>${escapeHtml(metadata.title)}</dd>
                <dt>File</dt><dd>${escapeHtml(metadata.sourceFileName)}</dd>
                <dt>Type</dt><dd>${escapeHtml(metadata.type)}</dd>
                <dt>Published</dt><dd><time datetime="${escapeHtml(metadata.createdAt)}" data-local-date>${escapeHtml(formatDate(metadata.createdAt, options.timeZone))}</time></dd>
              </dl>
            </section>
          </div>
        </details>
      </header>
      <div class="preview-frame">
        <iframe sandbox="allow-scripts" src="${contentPath}" title="${escapeHtml(metadata.title)}" data-document-frame></iframe>
      </div>
      <button class="toolbar-control show-frame" type="button" data-show-frame hidden>Show frame</button>
    </main>`,
    `Preview of ${metadata.title}`,
    basePath,
    options.appearance ?? "system",
    "document-page",
  );
}

function renderInboxFilter(sources: HubInboxListing[], selected: string): string {
  return `<label class="visually-hidden" for="inbox-filter">Inbox</label>
            <select id="inbox-filter" name="inbox" aria-label="Inbox">
              <option value="">All selected inboxes</option>
              ${sources.map((source) => `<option value="${escapeHtml(source.name)}"${source.name === selected ? " selected" : ""}>${escapeHtml(source.name)}</option>`).join("")}
            </select>`;
}

function renderAvailability(sources: HubInboxListing[]): string {
  const unavailable = sources.filter((source) => !source.available);
  if (unavailable.length === 0) {
    return "";
  }

  return `<p class="inbox-availability" role="status">Some inboxes are unavailable. Results are incomplete. Unavailable: ${unavailable.map((source) => escapeHtml(source.name)).join(", ")}.</p>\n      `;
}

function page(
  title: string,
  body: string,
  description: string,
  basePath: string,
  appearance: Appearance,
  bodyClass: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="html-inbox-appearance" content="${appearance}">
<script src="${basePath}/assets/viewer.js"></script>
<link rel="stylesheet" href="${basePath}/assets/viewer.css">
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main-content">Skip to content</a>
${body}
</body>
</html>`;
}

function renderBrand(homePath: string): string {
  return `<a class="brand" href="${homePath}" aria-label="HTML Inbox home">
    <span class="brand__mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3.25h10v9.5H3zM3 9h2.65l1.1 1.5h2.5l1.1-1.5H13" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>
    </span>
    <span class="brand__name">HTML Inbox</span>
  </a>`;
}

function renderAppearanceMenu(): string {
  return `<details class="viewer-menu" data-viewer-menu>
    <summary class="toolbar-control appearance-control">Appearance</summary>
    <div class="viewer-menu__panel">${renderAppearanceOptions()}</div>
  </details>`;
}

function renderAppearanceOptions(): string {
  return `<fieldset class="theme-switch">
    <legend>Appearance</legend>
    <div class="theme-switch__options">
      <label class="theme-switch__option"><input type="radio" name="appearance" value="system" data-theme-option checked><span>System</span></label>
      <label class="theme-switch__option"><input type="radio" name="appearance" value="light" data-theme-option><span>Light</span></label>
      <label class="theme-switch__option"><input type="radio" name="appearance" value="dark" data-theme-option><span>Dark</span></label>
    </div>
  </fieldset>`;
}

function formatDate(value: string, timeZone?: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
