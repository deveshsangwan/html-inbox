import { DOCUMENT_SCRIPT_CSP_SOURCES } from "./html-validation";
import { MAX_DOCUMENT_COPY_JSON_BYTES } from "./document-copy";

import { initializeViewer } from "./viewer-client";
import { initializeDocumentDeletion } from "./viewer-deletion-client";
import { initializeViewerCopy } from "./viewer-copy-client";

export const VIEWER_SCRIPT = `(${initializeViewer.toString()})();\n(${initializeViewerCopy.toString()})(${MAX_DOCUMENT_COPY_JSON_BYTES});\n(${initializeDocumentDeletion.toString()})();`;

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
  --danger: #b42332;
  --danger-soft: #fcebed;
  --danger-fill: #a82030;
  --danger-contrast: #ffffff;
  --iframe-canvas: #ffffff;
  --radius: 0.5rem;
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
  --danger: #ffa0aa;
  --danger-soft: #382029;
  --danger-fill: #f3a1aa;
  --danger-contrast: #310e13;
  --iframe-canvas: #101217;
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
  top: 0.5rem;
  left: 0.5rem;
  z-index: 5;
  padding: 0.55rem 0.85rem;
  color: var(--accent-contrast);
  background: var(--accent);
  border-radius: var(--radius);
  text-decoration: none;
  font-weight: 650;
  transform: translateY(-180%);
}
.skip-link:focus { transform: translateY(0); }
.toolbar-control {
  min-width: 2.75rem;
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0 0.6rem;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.2;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.toolbar-control:hover { color: var(--text-strong); background: var(--surface-sunken); }
.viewer-menu { position: relative; flex-shrink: 0; }
.viewer-menu > summary { list-style: none; }
.viewer-menu > summary::-webkit-details-marker { display: none; }
.viewer-menu[open] > summary { color: var(--accent); background: var(--accent-soft); }
.viewer-menu__panel {
  position: absolute;
  top: calc(100% + 0.35rem);
  right: 0;
  z-index: 4;
  width: min(20rem, calc(100vw - 1rem));
  max-height: calc(100dvh - 4rem);
  padding: 1rem;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
}
.theme-switch { min-width: 0; margin: 0; padding: 0; border: 0; }
.theme-switch legend { margin-bottom: 0.5rem; padding: 0; color: var(--text-strong); font-size: 0.8125rem; font-weight: 650; }
.theme-switch__options {
  display: flex;
  gap: 0.125rem;
  padding: 0.125rem;
  background: var(--canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.theme-switch__option { position: relative; display: inline-flex; flex: 1; }
.theme-switch__option input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }
.theme-switch__option span {
  min-width: 2.75rem;
  min-height: 2.75rem;
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  color: var(--muted);
  border-radius: 0.35rem;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}
.theme-switch__option:hover span { color: var(--text-strong); }
.theme-switch__option input:checked + span { color: var(--accent); background: var(--accent-soft); }
.theme-switch__option input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 1px; }
/* System colors preserve the selected appearance in forced-colors mode. */
@media (forced-colors: active) {
  .theme-switch__option input:checked + span { color: HighlightText; background-color: Highlight; }
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-strong);
  font-size: 0.875rem;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
}
.brand__mark {
  width: 1.75rem;
  height: 1.75rem;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
h1 { margin: 0; color: var(--text-strong); font-weight: 650; letter-spacing: -0.02em; }
.library { width: min(100% - 2rem, 74rem); margin-inline: auto; padding-block: 0.25rem 2rem; }
.library__bar { display: flex; align-items: center; gap: 0.75rem; min-height: 3rem; }
.library__title { min-width: 0; max-width: min(100%, 24rem); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 0.75rem; border-left: 1px solid var(--border); font-size: 0.875rem; }
.document-count { margin: 0.75rem 0 0.5rem; color: var(--faint); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.search { min-width: 0; width: min(100%, 28rem); margin-left: auto; }
.search__control { display: flex; align-items: center; gap: 0.4rem; }
.search__control input {
  flex: 1;
  min-width: 0;
  min-height: 2.75rem;
  width: 100%;
  padding: 0 0.75rem;
  color: var(--text-strong);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.search__control input:hover { border-color: var(--border-strong); }
.search__control input::placeholder { color: var(--faint); }
.search__control select { min-width: 0; max-width: 10rem; min-height: 2.75rem; padding: 0 0.5rem; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.inbox-badge { display: inline-block; padding: 0.1rem 0.4rem; color: var(--muted); background: var(--surface-sunken); border: 1px solid var(--border); border-radius: 0.25rem; font-size: 0.72rem; font-weight: 500; vertical-align: middle; }
.inbox-availability { padding: 0.65rem 0.75rem; color: var(--text); background: var(--surface-sunken); border: 1px solid var(--border); border-radius: var(--radius); }
.search__button, .search__clear {
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.search__button { color: var(--accent-contrast); background: var(--accent); border-color: var(--accent); }
.search__clear { color: var(--text); background: var(--surface); }
.document-list { display: grid; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.doc {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(4rem, 7rem) auto;
  grid-template-areas: "title source type date";
  align-items: center;
  gap: 0.4rem 1rem;
  min-height: 3.5rem;
  padding: 0.65rem 0.75rem;
  border-bottom: 1px solid var(--border);
}
.doc:hover, .doc:focus-within { background: var(--surface); }
.doc__title {
  grid-area: title;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-strong);
  font-size: 0.9rem;
  font-weight: 600;
  line-height: 1.4;
  text-decoration: none;
}
.doc__title::after { content: ""; position: absolute; inset: 0; }
.doc--deletable { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(4rem, 7rem) auto auto; grid-template-areas: "title source type date action"; }
.doc__actions { z-index: 1; grid-area: action; }
.doc__actions[open] { z-index: 5; }
.doc__actions > summary { font-size: 1.5rem; }
.doc__actions-panel { width: 10rem; padding: 0.25rem; }
.doc__actions-delete { justify-content: flex-start; width: 100%; }
.delete-action { color: var(--danger); }
.delete-action:hover { color: var(--danger); background: var(--danger-soft); }
.viewer-menu__delete { justify-content: flex-start; width: 100%; margin-top: 1rem; border-top: 1px solid var(--border); border-radius: 0; }
.doc__source { grid-area: source; min-width: 0; overflow: hidden; color: var(--faint); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
.document-date { grid-area: date; color: var(--muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.document-type {
  grid-area: type;
  justify-self: start;
  max-width: 7rem;
  padding: 0.1rem 0.4rem;
  overflow: hidden;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 0.25rem;
  font-size: 0.72rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty-state { padding: 2rem 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.empty-state h2 { margin: 0; color: var(--text-strong); font-size: 1.1rem; }
.empty-state p { max-width: 38rem; margin: 0.45rem 0 0; color: var(--muted); }
.empty-state code {
  display: block;
  max-width: 100%;
  margin-top: 1rem;
  padding: 0.65rem 0.8rem;
  overflow-x: auto;
  color: var(--text);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.75rem;
  white-space: nowrap;
}
.document-page { height: 100dvh; min-height: 0; overflow: hidden; }
.document-view { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.reader__bar {
  position: relative;
  z-index: 2;
  display: flex;
  flex: 0 0 3rem;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  padding: 0.125rem 0.375rem;
  border-bottom: 1px solid var(--border);
}
.back-link { color: var(--muted); }
.back-link > [aria-hidden] { font-size: 1.25rem; }
.document-title {
  flex: 1;
  min-width: 0;
  margin-inline: 0.5rem;
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reader__bar .viewer-menu > summary { font-size: 1.5rem; }
.document-details { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.document-details h2 { margin: 0 0 0.75rem; color: var(--text-strong); font-size: 0.8125rem; }
.document-details dl { display: grid; gap: 0.25rem; margin: 0; font-size: 0.8125rem; }
.document-details dt { margin-top: 0.4rem; color: var(--faint); font-size: 0.75rem; }
.document-details dd { margin: 0; overflow-wrap: anywhere; }
.copy-content { width: 100%; justify-content: flex-start; margin-bottom: 0.75rem; }
.copy-dialog {
  width: min(44rem, calc(100vw - 1rem));
  max-width: calc(100vw - 1rem);
  max-height: calc(100dvh - 1rem);
  margin: auto;
  padding: 1rem;
  overflow: auto;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  font: inherit;
}
.copy-dialog[open] { display: grid; gap: 0.75rem; }
.copy-dialog::backdrop { background: rgb(0 0 0 / 0.5); }
.copy-dialog .copy-dialog__header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.copy-dialog h2 { min-width: 0; margin: 0; color: var(--text-strong); font-size: 1.1rem; overflow-wrap: anywhere; }
.copy-dialog .copy-dialog__help { margin: 0; color: var(--muted); font-size: 0.8125rem; overflow-wrap: anywhere; }
.copy-dialog .copy-dialog__status { min-height: 1.5em; margin: 0; overflow-wrap: anywhere; }
.copy-dialog .copy-dialog__content { display: grid; min-width: 0; gap: 0.5rem; }
.copy-dialog label { color: var(--text-strong); font-size: 0.8125rem; font-weight: 600; }
.copy-dialog button, .copy-dialog select {
  min-width: 2.75rem;
  min-height: 2.75rem;
  max-width: 100%;
  padding: 0.5rem 0.75rem;
  color: var(--text);
  background: var(--surface-sunken);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  font: inherit;
}
.copy-dialog button { cursor: pointer; }
.copy-dialog button:hover { color: var(--text-strong); border-color: var(--accent); }
.copy-dialog button:disabled, .copy-dialog button[aria-disabled="true"] { opacity: 0.6; cursor: default; }
.copy-dialog select { width: 100%; }
.copy-dialog textarea {
  width: 100%;
  min-width: 0;
  height: clamp(6rem, 28dvh, 18rem);
  max-height: 40dvh;
  padding: 0.75rem;
  overflow: auto;
  resize: vertical;
  color: var(--text-strong);
  background: var(--canvas);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  font: 0.8125rem/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
}
.copy-dialog .copy-dialog__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.preview-frame {
  flex: 1;
  min-height: 0;
  margin: 0.5rem;
  overflow: hidden;
  background: var(--iframe-canvas);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
iframe { display: block; width: 100%; height: 100%; background: var(--iframe-canvas); color-scheme: inherit; border: 0; }
.show-frame {
  position: fixed;
  top: max(0.375rem, env(safe-area-inset-top));
  right: max(0.375rem, env(safe-area-inset-right));
  z-index: 3;
  min-height: 2.25rem;
  padding-inline: 0.75rem;
  background: var(--surface);
  border-color: var(--border-strong);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
  font-size: 0.75rem;
}
.show-frame:hover { background: var(--surface-sunken); }
[data-frame-hidden] .reader__bar { display: none; }
[data-frame-hidden] .preview-frame { margin: 0; border: 0; border-radius: 0; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.doc__title:focus-visible { outline-offset: 0.25rem; }
.deletion-notice { margin: 0.75rem 0; padding: 0.75rem; color: var(--text-strong); background: var(--accent-soft); border: 1px solid var(--border); border-radius: var(--radius); overflow-wrap: anywhere; }
.delete-dialog {
  width: min(30rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
  margin: auto;
  padding: 1.25rem;
  overflow: auto;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.24);
  font: inherit;
}
.delete-dialog::backdrop { background: rgb(0 0 0 / 0.5); }
.delete-dialog h2 { margin: 0; color: var(--text-strong); font-size: 1.125rem; line-height: 1.4; }
.delete-dialog p { margin: 0.75rem 0; }
.delete-dialog__details { display: grid; gap: 0.25rem; margin: 1rem 0; overflow-wrap: anywhere; }
.delete-dialog__details dt { color: var(--faint); font-size: 0.75rem; }
.delete-dialog__details dd { margin: 0 0 0.5rem; color: var(--text-strong); }
.delete-dialog__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem; }
.delete-dialog__cancel { background: var(--surface); border-color: var(--border-strong); }
.delete-dialog__confirm { color: var(--danger-contrast); background: var(--danger-fill); border-color: var(--danger-fill); }
.delete-dialog__confirm:hover { color: var(--danger-contrast); background: var(--danger-fill); filter: brightness(0.92); }
.delete-dialog__error { color: var(--danger); }
.delete-dialog__review { display: inline-flex; align-items: center; min-height: 2.75rem; color: var(--accent); }
.delete-dialog button:disabled { opacity: 0.65; cursor: default; }
.delete-dialog[aria-busy="true"] button:disabled { cursor: wait; }
@media (max-width: 52rem) {
  .doc { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "title date" "source type"; }
  .doc--deletable { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "title date action" "source type action"; }
  .document-type { justify-self: end; }
}
@media (max-width: 42rem) {
  .library { width: calc(100% - 1rem); }
  .library__bar { flex-wrap: wrap; gap: 0.25rem 0.5rem; }
  .library__bar > .viewer-menu { margin-left: auto; }
  .search { order: 1; flex-basis: 100%; width: 100%; margin: 0; }
  .brand { min-height: 2.75rem; }
  .back-link__text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .reader__bar { padding-inline: 0.125rem; }
  .document-title { margin-inline: 0.125rem; font-size: 0.8125rem; }
  .hide-frame { padding-inline: 0.5rem; font-size: 0.75rem; }
  .preview-frame { margin: 0.25rem; }
  .show-frame { min-height: 2.75rem; }
}
@media (max-width: 30rem) {
  .document-type { max-width: 5.5rem; }
  .doc { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "title type" "source source" "date date"; gap: 0.25rem 0.5rem; }
  .doc--deletable { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "title title action" "source type action" "date date action"; }
  .document-date { white-space: normal; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
}
`;

export const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'";

export const LIVE_SHELL_CSP = `${SHELL_CSP}; frame-ancestors 'none'`;

// Direct content URLs also need an opaque origin. Keep this in the response
// policy because CSP sandbox directives do not work in HTML meta elements.
export const DOCUMENT_CSP = `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${DOCUMENT_SCRIPT_CSP_SOURCES.join(" ")}; script-src-attr 'none'; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
