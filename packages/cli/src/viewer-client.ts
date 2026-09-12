export function initializeViewer(): void {
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

  const applyMode = (mode: string) => {
    const resolved =
      mode === "system" ? (media.matches ? "dark" : "light") : mode;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  };

  let mode = readMode();
  applyMode(mode);

  const initialize = () => {
    document
      .querySelectorAll<HTMLInputElement>("[data-theme-option]")
      .forEach((option) => {
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
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
}
