export function initializeViewer(): void {
  const root = document.documentElement;
  const storageKey = "html-inbox-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const modes = new Set(["system", "light", "dark"]);

  const configuredMode = document
    .querySelector('meta[name="html-inbox-appearance"]')
    ?.getAttribute("content");
  const defaultMode =
    configuredMode && modes.has(configuredMode) ? configuredMode : "system";

  const readMode = () => {
    try {
      const saved = window.localStorage.getItem(storageKey);

      return saved && modes.has(saved) ? saved : defaultMode;
    } catch {
      return defaultMode;
    }
  };

  const notifyDocument = () => {
    const frame = document.querySelector("[data-document-frame]");

    if (frame instanceof HTMLIFrameElement) {
      // The sandbox intentionally gives documents an opaque origin.
      frame.contentWindow?.postMessage(
        { type: "html-inbox:appearance", theme: root.dataset.theme },
        "*",
      );
    }
  };

  const applyMode = (mode: string) => {
    const resolved =
      mode === "system" ? (media.matches ? "dark" : "light") : mode;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;

    document
      .querySelectorAll<HTMLInputElement>("[data-theme-option]")
      .forEach((option) => {
        option.checked = option.value === mode;
      });
    notifyDocument();
  };

  let mode = readMode();
  applyMode(mode);

  const initialize = () => {
    document
      .querySelectorAll<HTMLInputElement>("[data-theme-option]")
      .forEach((option) => {
        option.checked = option.value === mode;
        option.addEventListener("change", () => {
          if (!option.checked || !modes.has(option.value)) {
            return;
          }

          mode = option.value;

          try {
            window.localStorage.setItem(storageKey, mode);
          } catch {}

          applyMode(mode);
        });
      });

    const frame = document.querySelector("[data-document-frame]");

    if (frame instanceof HTMLIFrameElement) {
      frame.addEventListener("load", notifyDocument);
      notifyDocument();
    }

    const hideFrame = document.querySelector("[data-hide-frame]");
    const showFrame = document.querySelector("[data-show-frame]");

    if (
      hideFrame instanceof HTMLButtonElement &&
      showFrame instanceof HTMLButtonElement
    ) {
      hideFrame.addEventListener("click", () => {
        document
          .querySelectorAll<HTMLDetailsElement>("[data-viewer-menu]")
          .forEach((menu) => {
            menu.open = false;
          });

        document.body.dataset.frameHidden = "";
        showFrame.hidden = false;
        showFrame.focus({ preventScroll: true });
      });

      showFrame.addEventListener("click", () => {
        delete document.body.dataset.frameHidden;
        showFrame.hidden = true;
        hideFrame.focus({ preventScroll: true });
      });
    }

    const menus = Array.from(
      document.querySelectorAll<HTMLDetailsElement>("[data-viewer-menu]"),
    );

    if (frame instanceof HTMLIFrameElement) {
      window.addEventListener("blur", () => {
        // The sandbox prevents document clicks from reaching the viewer.
        // Wait for focus to settle before identifying a click inside the frame.
        window.setTimeout(() => {
          if (document.activeElement !== frame) {
            return;
          }

          menus.forEach((menu) => {
            menu.open = false;
          });
        }, 0);
      });
    }

    document.addEventListener("click", (event) => {
      const target = event.target;

      if (!(target instanceof Node)) {
        return;
      }

      menus.forEach((menu) => {
        if (!menu.contains(target)) {
          menu.open = false;
        }
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }

      menus.forEach((menu) => {
        if (!menu.open) {
          return;
        }

        menu.open = false;
        menu.querySelector("summary")?.focus();
      });
    });

    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    document
      .querySelectorAll<HTMLTimeElement>("time[data-local-date]")
      .forEach((element) => {
        const date = new Date(element.dateTime);
        if (!Number.isNaN(date.valueOf())) {
          element.textContent = dateFormatter.format(date);
        }
      });

    const searchForm = document.querySelector("[data-client-search]");
    if (searchForm instanceof HTMLFormElement) {
      const input = searchForm.querySelector('input[name="q"]');
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-search-text]"),
      );
      const count = document.querySelector("[data-document-count]");
      const empty = document.querySelector<HTMLElement>("[data-client-empty]");
      const clear = searchForm.querySelector<HTMLElement>(
        "[data-search-clear]",
      );
      const submit = searchForm.querySelector<HTMLElement>(
        "[data-search-submit]",
      );
      const total = rows.length;
      if (submit) submit.hidden = true;

      const applySearch = (value: string) => {
        const query = value.trim().slice(0, 200).toLowerCase();
        let visible = 0;
        rows.forEach((row) => {
          const matches =
            !query || (row.dataset.searchText || "").includes(query);
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

      const initialQuery =
        new URL(window.location.href).searchParams.get("q") || "";
      if (input instanceof HTMLInputElement) input.value = initialQuery;
      applySearch(initialQuery);

      const commit = (value: string) => {
        const url = new URL(window.location.href);
        const query = value.trim().slice(0, 200);
        if (query) url.searchParams.set("q", query);
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
          commit("");
          if (input instanceof HTMLInputElement) input.focus();
        });
      }
    }
  };

  media.addEventListener("change", () => {
    if (mode === "system") applyMode(mode);
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) {
      return;
    }

    mode = readMode();
    applyMode(mode);
  });

  document.addEventListener("DOMContentLoaded", initialize, { once: true });
}
