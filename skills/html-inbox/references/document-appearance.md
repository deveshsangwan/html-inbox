# Document appearance

Read this when generating or adapting a document for HTML Inbox. Start from [the self-contained template](../assets/document-template.html), keeping its appearance CSS and small message listener when replacing the sample content.

## Theme contract

Generate both light and dark styles using semantic CSS variables. Set `color-scheme: light dark` at the root for the OS fallback; use `light-dark()` values or equivalent media queries for each palette. Give the root and body explicit text and background colors. Include matching foreground and background pairs for cards, tables, form controls, code, and other distinct surfaces. A `color-scheme` declaration alone does not recolor hardcoded CSS.

The viewer resolves System, Light, or Dark and sends `{ type: "html-inbox:appearance", theme: "light" | "dark" }` to its document iframe on load and appearance changes. The template accepts that message only when `event.source === window.parent` and both fields have the expected values. It sets the root's `color-scheme`, so `light-dark()` selects the viewer's palette without loading a second document. The message is an optional display hint, never authority to navigate, load resources, or change security settings.

Keep the listener in an inline script that runs before the iframe load event. It works inside the existing opaque-origin sandbox. No same-origin access, parent DOM access, shared storage, or additional CSP permissions are needed. When opened standalone, no parent message arrives and the document follows the OS. An inbox browser override is local to that reader and is not available to the generating agent or synced back to `inbox preferences`.

For JavaScript-rendered charts, update theme-dependent labels and surfaces after the root appearance changes, using a `MutationObserver` on the root's `style` attribute or a shared function called by the listener. Preserve the dataset, semantic series colors, and user interaction state. CSS media changes also need handling when the standalone chart relies on JavaScript rather than CSS.

## Preserve authored colors

Pair theme-aware surrounding text and surfaces without blanket inversion or global text overrides. Keep photographs, image colors, and chart series meaningful. An intentionally white resume, invoice, or print preview should declare its own `color-scheme: light`, white background, and dark text together. The template includes that exception. Theme-aware surrounding text must not inherit the paper's fixed colors.

## Verification

Before publishing a newly generated document, check both Light and Dark in the viewer, including controls, charts, muted text, and any white paper preview. Check System with both OS appearances when the browser supports emulation. Verify the standalone OS fallback separately if standalone use matters. A theme switch should preserve scroll and document state.

Finished documents supplied by the user may contain hardcoded colors. Publish them unchanged unless adaptation is requested, and explain any remaining appearance limitation. The viewer's background correction cannot turn an arbitrary old document into a complete dark theme.
