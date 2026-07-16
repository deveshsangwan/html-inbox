import { DOCUMENT_SCRIPT_CSP_SOURCES } from "@html-inbox/shared";

export const VIEWER_SCRIPT = `(() => {
  const root = document.documentElement;
  const storageKey = "html-inbox-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const modes = new Set(["system", "light", "dark"]);

  const readMode = () => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved && modes.has(saved) ? saved : "system";
    } catch {
      return "system";
    }
  };

  const applyMode = (mode) => {
    const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  };

  let mode = readMode();
  applyMode(mode);

  const initialize = () => {
    const selector = document.querySelector("[data-theme-selector]");
    if (selector instanceof HTMLSelectElement) {
      selector.value = mode;
      selector.addEventListener("change", () => {
        mode = modes.has(selector.value) ? selector.value : "system";
        try {
          window.localStorage.setItem(storageKey, mode);
        } catch {}
        applyMode(mode);
      });
    }

    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    document.querySelectorAll("time[data-local-date]").forEach((element) => {
      const date = new Date(element.dateTime);
      if (!Number.isNaN(date.valueOf())) {
        element.textContent = dateFormatter.format(date);
      }
    });

    const searchForm = document.querySelector("[data-client-search]");
    if (searchForm instanceof HTMLFormElement) {
      const input = searchForm.querySelector('input[name="q"]');
      const rows = Array.from(document.querySelectorAll("[data-search-text]"));
      const count = document.querySelector("[data-document-count]");
      const empty = document.querySelector("[data-client-empty]");
      const clear = searchForm.querySelector("[data-search-clear]");
      const total = rows.length;

      const applySearch = (value) => {
        const query = value.trim().toLowerCase();
        let visible = 0;
        rows.forEach((row) => {
          const matches = !query || (row.dataset.searchText || "").includes(query);
          row.hidden = !matches;
          if (matches) visible += 1;
        });
        if (count) {
          count.textContent = query
            ? visible + " of " + total + " documents"
            : total + (total === 1 ? " document" : " documents");
        }
        if (empty) empty.hidden = !query || visible > 0;
        if (clear) clear.hidden = !query;
      };

      const initialQuery = new URL(window.location.href).searchParams.get("q") || "";
      if (input instanceof HTMLInputElement) input.value = initialQuery;
      applySearch(initialQuery);

      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input instanceof HTMLInputElement ? input.value : "";
        const url = new URL(window.location.href);
        if (value.trim()) url.searchParams.set("q", value.trim());
        else url.searchParams.delete("q");
        window.history.replaceState(null, "", url);
        applySearch(value);
      });
      if (clear) {
        clear.addEventListener("click", (event) => {
          event.preventDefault();
          if (input instanceof HTMLInputElement) input.value = "";
          const url = new URL(window.location.href);
          url.searchParams.delete("q");
          window.history.replaceState(null, "", url);
          applySearch("");
          if (input instanceof HTMLInputElement) input.focus();
        });
      }
    }
  };

  media.addEventListener("change", () => {
    if (mode === "system") applyMode(mode);
  });
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
})();`;

export const VIEWER_STYLES = `
:root {
  --canvas: #f3f4f5;
  --surface: #ffffff;
  --surface-raised: #ffffff;
  --surface-hover: #e9eeeb;
  --text: #343a36;
  --text-strong: #161a17;
  --muted: #5d655f;
  --faint: #646c66;
  --border: #d9ddda;
  --border-strong: #bcc4be;
  --accent: #2f6a50;
  --accent-soft: #e1ebe5;
  --accent-contrast: #f7faf8;
  --focus: #2f6a50;
  --iframe-canvas: #ffffff;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color-scheme: light;
}

[data-theme="dark"] {
  --canvas: #111412;
  --surface: #171b18;
  --surface-raised: #1a1f1b;
  --surface-hover: #202621;
  --text: #d8ded9;
  --text-strong: #f4f7f5;
  --muted: #aab2ac;
  --faint: #89918b;
  --border: #2e3530;
  --border-strong: #434c45;
  --accent: #8ab79c;
  --accent-soft: #223a2c;
  --accent-contrast: #111412;
  --focus: #a6d1b7;
  --iframe-canvas: #ffffff;
  color-scheme: dark;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { min-height: 100%; background: var(--canvas); }
body {
  min-height: 100dvh;
  margin: 0;
  color: var(--text);
  background: var(--canvas);
  font-size: 0.9375rem;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
button, select { font: inherit; }
a { color: inherit; }

.skip-link {
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 2;
  padding: 0.55rem 0.8rem;
  color: var(--surface-raised);
  background: var(--text-strong);
  border-radius: 0.4rem;
  transform: translateY(-180%);
  transition: transform 150ms ease;
}
.skip-link:focus { transform: translateY(0); }

.site-header {
  border-bottom: 1px solid var(--border);
  background: var(--canvas);
}
.site-header__inner,
.library,
.document-view {
  width: min(100% - 2.5rem, 72rem);
  margin-inline: auto;
}
.site-header__inner {
  min-height: 4rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.68rem;
  color: var(--text-strong);
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.015em;
  text-decoration: none;
}
.brand__mark {
  width: 1.75rem;
  height: 1.75rem;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 0.4rem;
}
.theme-field {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 550;
}
.theme-field select {
  min-height: 2.125rem;
  padding: 0 1.9rem 0 0.7rem;
  color: var(--text);
  background-color: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  cursor: pointer;
}

.library { padding-block: 3rem 4rem; }
.library__heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 2rem;
  padding-bottom: 1.5rem;
}
h1 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
  font-size: 2rem;
  font-weight: 680;
  letter-spacing: -0.03em;
  line-height: 1.1;
  text-wrap: balance;
}
.library__intro {
  max-width: 42rem;
  margin: 0.5rem 0 0;
  color: var(--muted);
  font-size: 0.9375rem;
  text-wrap: pretty;
}
.document-count {
  margin: 0 0 0.15rem;
  color: var(--faint);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.search-form {
  max-width: 38rem;
  margin-bottom: 2rem;
}
.search-form label {
  display: block;
  margin-bottom: 0.45rem;
  color: var(--text-strong);
  font-size: 0.8rem;
  font-weight: 620;
}
.search-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.55rem;
  align-items: center;
}
.search-control input {
  min-width: 0;
  min-height: 2.55rem;
  padding: 0 0.75rem;
  color: var(--text-strong);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 0.375rem;
  font: inherit;
}
.search-control input::placeholder { color: var(--faint); }
.search-control button,
.search-clear {
  min-height: 2.55rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.85rem;
  border-radius: 0.375rem;
  font-size: 0.82rem;
  font-weight: 620;
  text-decoration: none;
  white-space: nowrap;
}
.search-control button {
  color: var(--accent-contrast);
  background: var(--accent);
  border: 1px solid var(--accent);
  cursor: pointer;
}
.search-clear {
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
}
.search-control button:hover { filter: brightness(0.94); }
.search-clear:hover { border-color: var(--border-strong); }
.search-control button:active,
.search-clear:active { transform: translateY(1px); }

.document-list {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border-strong);
}
.document-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(15rem, 22rem) 1.25rem;
  gap: 1rem;
  align-items: center;
  min-height: 4.75rem;
  padding: 0.9rem 0.35rem;
  border-bottom: 1px solid var(--border);
  transition: background-color 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.document-row:hover,
.document-row:focus-within {
  background: var(--surface-hover);
}
.document-row__link {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
  font-size: 1rem;
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: 1.3;
  text-decoration: none;
  text-wrap: pretty;
}
.document-row__link::after { content: ""; position: absolute; inset: 0; }
.document-row__meta { min-width: 0; }
.document-row__details {
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.55rem;
  margin-bottom: 0.35rem;
}
.document-type {
  min-width: 0;
  max-width: 100%;
  padding: 0.12rem 0.38rem;
  overflow-wrap: anywhere;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 0.25rem;
  font-size: 0.75rem;
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1.45;
}
.document-date {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}
.document-source {
  display: block;
  overflow: hidden;
  color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-row__arrow {
  color: var(--faint);
  font-size: 1.2rem;
  transition: color 180ms cubic-bezier(0.22, 1, 0.36, 1), transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.document-row:hover .document-row__arrow,
.document-row:focus-within .document-row__arrow {
  color: var(--accent);
  transform: translateX(0.2rem);
}

.empty-state {
  padding: 2.5rem 0;
  border-top: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border);
}
.empty-state h2 { margin: 0; color: var(--text-strong); font-size: 1.15rem; letter-spacing: -0.02em; }
.empty-state p { max-width: 38rem; margin: 0.5rem 0 0; color: var(--muted); }
.empty-state code {
  display: inline-block;
  max-width: 100%;
  margin-top: 1.2rem;
  padding: 0.55rem 0.75rem;
  overflow-x: auto;
  color: var(--text);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.75rem;
  white-space: nowrap;
}

.document-view { padding-block: 1.5rem 2rem; }
.document-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2rem;
  align-items: end;
  margin-bottom: 1.35rem;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 1rem;
  color: var(--muted);
  font-size: 0.82rem;
  font-weight: 570;
  text-decoration: none;
  transition: color 160ms cubic-bezier(0.22, 1, 0.36, 1), transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.back-link:hover { color: var(--accent); transform: translateX(-0.15rem); }
.document-title {
  max-width: 48rem;
  font-size: 1.75rem;
  line-height: 1.12;
}
.document-header__meta {
  min-width: min(18rem, 32vw);
  max-width: min(24rem, 38vw);
  padding-bottom: 0.15rem;
  text-align: right;
}
.document-header__meta .document-row__details { justify-content: flex-end; }
.document-header__source {
  display: block;
  overflow: hidden;
  margin-top: 0.55rem;
  color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.73rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-frame {
  padding: 0.25rem;
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: 0.5rem;
}
iframe {
  width: 100%;
  height: max(35rem, calc(100dvh - 12.5rem));
  display: block;
  background: var(--iframe-canvas);
  border: 0;
  border-radius: 0.25rem;
}

:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.document-row__link:focus-visible { outline-offset: 0.35rem; border-radius: 0.15rem; }
select:hover { border-color: var(--border-strong); }
select:active { transform: translateY(1px); }

@media (max-width: 42rem) {
  .site-header__inner, .library, .document-view { width: min(100% - 1.5rem, 72rem); }
  .theme-field > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .library { padding-block: 2.25rem 3rem; }
  .library__heading, .document-header { grid-template-columns: 1fr; gap: 0.85rem; }
  .document-count { margin: 0; }
  .search-control { grid-template-columns: minmax(0, 1fr) auto; }
  .search-clear { grid-column: 1 / -1; justify-self: start; }
  .document-row { grid-template-columns: minmax(0, 1fr) 1.25rem; gap: 0.8rem; padding-block: 1.25rem; }
  .document-row__meta { grid-column: 1; }
  .document-row__arrow { grid-column: 2; grid-row: 1 / span 2; }
  .document-header__meta { min-width: 0; max-width: none; text-align: left; }
  .document-header__meta .document-row__details { justify-content: flex-start; }
  .document-view { padding-top: 1.25rem; }
  iframe { height: max(30rem, calc(100dvh - 15.5rem)); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
`;

export function shellCsp(): string {
  return "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'";
}

export function documentCsp(): string {
  return `default-src 'none'; script-src 'unsafe-inline' ${DOCUMENT_SCRIPT_CSP_SOURCES.join(" ")}; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
}

