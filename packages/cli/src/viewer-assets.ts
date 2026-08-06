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
    document.querySelectorAll("[data-theme-option]").forEach((option) => {
      option.checked = option.value === mode;
      option.addEventListener("change", () => {
        if (!option.checked || !modes.has(option.value)) return;
        mode = option.value;
        try {
          window.localStorage.setItem(storageKey, mode);
        } catch {}
        applyMode(mode);
      });
    });

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
      const submit = searchForm.querySelector("[data-search-submit]");
      const total = rows.length;
      if (submit) submit.hidden = true;

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

      const commit = (value) => {
        const url = new URL(window.location.href);
        if (value.trim()) url.searchParams.set("q", value.trim());
        else url.searchParams.delete("q");
        window.history.replaceState(null, "", url);
        applySearch(value);
      };

      searchForm.addEventListener("submit", (event) => {
        event.preventDefault();
        commit(input instanceof HTMLInputElement ? input.value : "");
      });
      if (input instanceof HTMLInputElement) {
        input.addEventListener("input", () => commit(input.value));
      }
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
  --canvas: #f4f5f7;
  --surface: #ffffff;
  --surface-sunken: #e9ecf1;
  --text: #3d434f;
  --text-strong: #16181d;
  --muted: #5d626d;
  --faint: #656a78;
  --border: #d7dbe4;
  --border-strong: #c3c9d5;
  --accent: #3858c7;
  --accent-soft: #dce4ff;
  --accent-contrast: #f7f8ff;
  --focus: #3858c7;
  --iframe-canvas: #ffffff;
  --radius: 0.75rem;
  --radius-control: 0.5rem;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color-scheme: light;
}

[data-theme="dark"] {
  --canvas: #101217;
  --surface: #171a21;
  --surface-sunken: #1d2230;
  --text: #ced3dd;
  --text-strong: #f1f3f7;
  --muted: #a9afba;
  --faint: #8f96a3;
  --border: #282e3a;
  --border-strong: #3a4150;
  --accent: #91a5ff;
  --accent-soft: #202b50;
  --accent-contrast: #0e1222;
  --focus: #91a5ff;
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
button, select, input { font: inherit; }
a { color: inherit; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.skip-link {
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 3;
  padding: 0.55rem 0.85rem;
  color: var(--accent-contrast);
  background: var(--accent);
  border-radius: var(--radius-control);
  text-decoration: none;
  font-weight: 650;
  transform: translateY(-180%);
  transition: transform 150ms var(--ease);
}
.skip-link:focus { transform: translateY(0); }

.site-header {
  position: sticky;
  top: 0;
  z-index: 2;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--canvas) 88%, transparent);
  backdrop-filter: blur(12px);
}
.site-header__inner,
.library,
.document-view {
  width: min(100% - 2.5rem, 74rem);
  margin-inline: auto;
}
.site-header__inner {
  min-height: 3.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  color: var(--text-strong);
  font-size: 0.9rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  text-decoration: none;
}
.brand__mark {
  width: 1.6rem;
  height: 1.6rem;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  border-radius: var(--radius-control);
}
.theme-switch {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  margin: 0;
  padding: 0.125rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}
.theme-switch__option { position: relative; display: inline-flex; }
.theme-switch__option input {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  margin: 0;
  opacity: 0;
  pointer-events: none;
}
.theme-switch__option span {
  padding: 0.2rem 0.5rem;
  color: var(--muted);
  border-radius: calc(var(--radius-control) - 0.15rem);
  font-size: 0.75rem;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  transition: color 160ms var(--ease), background-color 160ms var(--ease);
}
.theme-switch__option:hover span { color: var(--text-strong); }
.theme-switch__option input:checked + span {
  color: var(--accent);
  background: var(--accent-soft);
}
.theme-switch__option input:focus-visible + span {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
/* Forced colors normalizes the authored checked colors; system keywords survive it. */
@media (forced-colors: active) {
  .theme-switch__option input:checked + span {
    color: HighlightText;
    background-color: Highlight;
  }
}

/* Index */
.library { padding-block: 2rem 4rem; }
.library__bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(0, 22rem);
  align-items: center;
  gap: 0.9rem 1.25rem;
  margin-bottom: 1.5rem;
}
h1 {
  margin: 0;
  color: var(--text-strong);
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.15;
}
.document-count {
  margin: 0;
  color: var(--faint);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}
.search__control {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.search__control input {
  flex: 1;
  min-width: 0;
  min-height: 2.4rem;
  padding: 0 0.75rem;
  color: var(--text-strong);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  transition: border-color 160ms var(--ease), box-shadow 160ms var(--ease);
}
.search__control input:hover { border-color: var(--border-strong); }
.search__control input::placeholder { color: var(--faint); }
.search__button,
.search__clear {
  min-height: 2.4rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.8rem;
  border-radius: var(--radius-control);
  font-size: 0.82rem;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: filter 160ms var(--ease), border-color 160ms var(--ease), transform 120ms var(--ease);
}
.search__button {
  color: var(--accent-contrast);
  background: var(--accent);
  border: 1px solid var(--accent);
}
.search__clear {
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
}
.search__button:hover { filter: brightness(1.08); }
.search__clear:hover { border-color: var(--border-strong); }
.search__button:active,
.search__clear:active { transform: translateY(1px); }

.document-list {
  display: grid;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.doc {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas: "title date" "source type";
  align-items: center;
  gap: 0.3rem 1.25rem;
  padding: 0.85rem 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 180ms var(--ease), box-shadow 180ms var(--ease), transform 180ms var(--ease);
}
.doc:hover,
.doc:focus-within {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  box-shadow: inset 3px 0 0 var(--accent);
  transform: translateY(-1px);
}
.doc__title {
  grid-area: title;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
  font-size: 0.975rem;
  font-weight: 650;
  letter-spacing: -0.015em;
  line-height: 1.3;
  text-decoration: none;
  text-wrap: pretty;
}
.doc__title::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
.doc__source {
  grid-area: source;
  min-width: 0;
  overflow: hidden;
  color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.73rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.document-date {
  grid-area: date;
  color: var(--muted);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.document-type {
  grid-area: type;
  justify-self: end;
  max-width: 12rem;
  padding: 0.1rem 0.45rem;
  overflow: hidden;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 0.3rem;
  font-size: 0.72rem;
  font-weight: 650;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-state {
  padding: 2.5rem 1.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.empty-state h2 { margin: 0; color: var(--text-strong); font-size: 1.1rem; letter-spacing: -0.02em; }
.empty-state p { max-width: 38rem; margin: 0.45rem 0 0; color: var(--muted); }
.empty-state code {
  display: block;
  max-width: 100%;
  margin-top: 1.2rem;
  padding: 0.65rem 0.8rem;
  overflow-x: auto;
  color: var(--text);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.75rem;
  white-space: nowrap;
}

/* Reader */
.document-view { padding-block: 1.25rem 1.75rem; }
.reader__bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.4rem 1.5rem;
  margin-bottom: 0.9rem;
}
.back-link {
  grid-column: 1 / -1;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 600;
  text-decoration: none;
  transition: color 160ms var(--ease);
}
.back-link:hover { color: var(--accent); }
.document-title {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 1.3rem;
  line-height: 1.2;
}
.reader__meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.reader__meta .document-type,
.reader__meta .document-date { grid-area: auto; }
.document-header__source {
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  color: var(--faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.73rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-frame {
  overflow: hidden;
  background: var(--iframe-canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
iframe {
  width: 100%;
  height: max(32rem, calc(100dvh - 11.5rem));
  display: block;
  background: var(--iframe-canvas);
  border: 0;
}

:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.doc__title:focus-visible { outline-offset: 0.4rem; }

@media (max-width: 52rem) {
  .library__bar { grid-template-columns: auto minmax(0, 1fr); }
  .search { grid-column: 1 / -1; }
}

@media (max-width: 42rem) {
  .site-header__inner, .library, .document-view { width: min(100% - 1.5rem, 74rem); }
  .site-header__inner { gap: 0.75rem; }
  .theme-switch__option span { padding: 0.2rem 0.4rem; font-size: 0.72rem; }
  .library { padding-block: 1.5rem 3rem; }
  .doc {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "title" "source" "date" "type";
    justify-items: start;
    gap: 0.35rem;
    padding: 1rem;
  }
  .doc__source, .document-date, .document-type { max-width: 100%; }
  .document-type { justify-self: start; }
  .reader__bar { grid-template-columns: minmax(0, 1fr); }
  .reader__meta { justify-content: flex-start; }
  iframe { height: max(28rem, calc(100dvh - 14rem)); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
`;

export function shellCsp(): string {
  return "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'";
}

export function documentCsp(): string {
  return `default-src 'none'; script-src 'unsafe-inline' ${DOCUMENT_SCRIPT_CSP_SOURCES.join(" ")}; script-src-attr 'none'; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
}
