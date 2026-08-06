import { type DocumentMetadata } from "@html-inbox/shared";

export interface ViewerRenderOptions {
  basePath?: string;
  clientSearch?: boolean;
  timeZone?: string;
}

export function renderIndex(
  allDocuments: DocumentMetadata[],
  query: string,
  options: ViewerRenderOptions = {},
): string {
  const basePath = options.basePath ?? "";
  const homePath = basePath ? `${basePath}/` : "/";
  const normalizedQuery = query.toLowerCase();
  const documents = normalizedQuery
    ? allDocuments.filter((document) =>
        [document.title, document.type, document.sourceFileName].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        ),
      )
    : allDocuments;
  const documentContent =
    documents.length === 0
      ? `<section class="empty-state" aria-labelledby="empty-title">
          <h2 id="empty-title">${query ? "No matching documents" : "No documents yet"}</h2>
          <p>${
            query
              ? "Try another title, type, or source file name."
              : "Publish an HTML file from the CLI. It will appear here with its title, type, and source file."
          }</p>
          ${
            query
              ? ""
              : '<code>html-inbox publish ./document.html --title "My document" --type report</code>'
          }
        </section>`
      : `<ol class="document-list" aria-label="Published documents">${documents
          .map(
            (document) =>
              `<li class="doc" data-search-text="${escapeAttribute(
                [document.title, document.type, document.sourceFileName]
                  .join(" ")
                  .toLowerCase(),
              )}">
                <a class="doc__title" href="${basePath}/documents/${escapeAttribute(document.id)}${basePath ? "/" : ""}">${escapeHtml(document.title)}</a>
                <time class="document-date" datetime="${escapeAttribute(document.createdAt)}" data-local-date>${escapeHtml(formatDate(document.createdAt, options.timeZone))}</time>
                <span class="doc__source" title="${escapeAttribute(document.sourceFileName)}">${escapeHtml(document.sourceFileName)}</span>
                <span class="document-type">${escapeHtml(document.type)}</span>
              </li>`,
          )
          .join("")}</ol>`;

  const countLabel = query
    ? `${documents.length} of ${allDocuments.length} documents`
    : `${documents.length} ${documents.length === 1 ? "document" : "documents"}`;

  return page(
    "HTML Inbox",
    `<main class="library" id="main-content">
      <header class="library__bar">
        <h1>Inbox</h1>
        <p class="document-count" aria-live="polite" data-document-count>${countLabel}</p>
        <form class="search" role="search" method="get" action="${homePath}" ${options.clientSearch ? "data-client-search" : ""}>
          <label class="visually-hidden" for="document-search">Search documents</label>
          <div class="search__control">
            <input id="document-search" name="q" type="search" value="${escapeAttribute(query)}" placeholder="Search title, type, or file" maxlength="200">
            <button class="search__button" type="submit" data-search-submit>Search</button>
            ${
              options.clientSearch
                ? `<a class="search__clear" href="${homePath}" data-search-clear${
                    query ? "" : " hidden"
                  }>Clear</a>`
                : query
                  ? `<a class="search__clear" href="${homePath}">Clear</a>`
                  : ""
            }
          </div>
        </form>
      </header>
      ${
        options.clientSearch && allDocuments.length > 0
          ? '<section class="empty-state" aria-labelledby="client-empty-title" data-client-empty hidden><h2 id="client-empty-title">No matching documents</h2><p>Try another title, type, or source file name.</p></section>'
          : ""
      }
      ${documentContent}
    </main>`,
    "Your published HTML documents, collected in one quiet library.",
    basePath,
  );
}

export function renderDocumentShell(
  metadata: DocumentMetadata,
  options: ViewerRenderOptions = {},
): string {
  const basePath = options.basePath ?? "";
  const homePath = basePath ? `${basePath}/` : "/";
  const contentPath = basePath
    ? `${basePath}/documents/${escapeAttribute(metadata.id)}/content/`
    : `/documents/${escapeAttribute(metadata.id)}/content`;
  return page(
    metadata.title,
    `<main class="document-view" id="main-content">
      <header class="reader__bar">
        <a class="back-link" href="${homePath}"><span aria-hidden="true">&#8592;</span> Back to inbox</a>
        <h1 class="document-title">${escapeHtml(metadata.title)}</h1>
        <div class="reader__meta">
          <span class="document-type">${escapeHtml(metadata.type)}</span>
          <time class="document-date" datetime="${escapeAttribute(metadata.createdAt)}" data-local-date>${escapeHtml(formatDate(metadata.createdAt, options.timeZone))}</time>
        </div>
        <span class="document-header__source" title="${escapeAttribute(metadata.sourceFileName)}">${escapeHtml(metadata.sourceFileName)}</span>
      </header>
      <div class="preview-frame">
        <iframe sandbox="allow-scripts" src="${contentPath}" title="${escapeAttribute(metadata.title)}"></iframe>
      </div>
    </main>`,
    `Preview of ${metadata.title}`,
    basePath,
  );
}

function page(title: string, body: string, description: string, basePath: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttribute(description)}">
<script src="${basePath}/assets/viewer.js"></script>
<link rel="stylesheet" href="${basePath}/assets/viewer.css">
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
${renderSiteHeader(basePath)}
${body}
</body>
</html>`;
}

function renderSiteHeader(basePath: string): string {
  const homePath = basePath ? `${basePath}/` : "/";
  return `<header class="site-header">
    <div class="site-header__inner">
      <a class="brand" href="${homePath}" aria-label="HTML Inbox home">
        <span class="brand__mark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 3.25h10v9.5H3zM3 9h2.65l1.1 1.5h2.5l1.1-1.5H13" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>
        </span>
        <span>HTML Inbox</span>
      </a>
      <fieldset class="theme-switch">
        <legend class="visually-hidden">Appearance</legend>
        <label class="theme-switch__option"><input type="radio" name="appearance" value="system" data-theme-option checked><span>System</span></label>
        <label class="theme-switch__option"><input type="radio" name="appearance" value="light" data-theme-option><span>Light</span></label>
        <label class="theme-switch__option"><input type="radio" name="appearance" value="dark" data-theme-option><span>Dark</span></label>
      </fieldset>
    </div>
  </header>`;
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

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
