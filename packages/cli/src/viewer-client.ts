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

  const initializeDeletion = () => {
    const dialog = document.querySelector("[data-delete-dialog]");
    const form = document.querySelector("[data-delete-form]");
    const cancel = document.querySelector("[data-delete-cancel]");
    const confirm = document.querySelector("[data-delete-confirm]");
    const title = document.querySelector("[data-delete-title]");
    const file = document.querySelector("[data-delete-file]");
    const inbox = document.querySelector("[data-delete-inbox]");
    const progress = document.querySelector("[data-delete-progress]");
    const error = document.querySelector("[data-delete-error]");
    const review = document.querySelector("[data-delete-review]");

    if (
      !(dialog instanceof HTMLDialogElement) ||
      !(form instanceof HTMLFormElement) ||
      !(cancel instanceof HTMLButtonElement) ||
      !(confirm instanceof HTMLButtonElement) ||
      !(title instanceof HTMLElement) ||
      !(file instanceof HTMLElement) ||
      !(inbox instanceof HTMLElement) ||
      !(progress instanceof HTMLElement) ||
      !(error instanceof HTMLElement) ||
      !(review instanceof HTMLAnchorElement) ||
      !dialog.dataset.deleteToken
    ) {
      return;
    }

    const token = dialog.dataset.deleteToken;
    const home = new URL(dialog.dataset.homePath ?? "/", window.location.origin);
    const returnKey = "html-inbox-list-return";
    const receiptKey = "html-inbox-deletion-receipt";
    const isReader = document.body.classList.contains("document-page");

    const readNavigation = (key: string): Record<string, unknown> | undefined => {
      try {
        const saved: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
        window.sessionStorage.removeItem(key);

        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
          return Object.fromEntries(Object.entries(saved));
        }
      } catch {}
    };

    const saveNavigation = (key: string, value: object) => {
      try {
        window.sessionStorage.setItem(key, JSON.stringify(value));
      } catch {}
    };

    const listDestination = (value: unknown) => {
      if (typeof value !== "string") {
        return;
      }

      try {
        const url = new URL(value, window.location.origin);
        const ownInbox = home.searchParams.get("inbox");
        const hasValidSearch = Array.from(url.searchParams).every(([key, value]) =>
          (key === "q" && value.length <= 200) ||
          (key === "inbox" && (!ownInbox || !value || value === ownInbox)),
        );

        if (
          url.origin === window.location.origin &&
          url.pathname === home.pathname &&
          !url.username && !url.password && !url.hash &&
          url.searchParams.getAll("q").length <= 1 &&
          url.searchParams.getAll("inbox").length <= 1 &&
          hasValidSearch
        ) {
          return `${url.pathname}${url.search}`;
        }
      } catch {}
    };

    const currentList = `${window.location.pathname}${window.location.search}`;
    const returnContext = isReader ? readNavigation(returnKey) : undefined;
    const returnPath = returnContext?.documentPath === window.location.pathname
      ? listDestination(returnContext.listPath)
      : undefined;
    const destination = isReader ? returnPath ?? `${home.pathname}${home.search}` : currentList;
    const scrollPosition = (value: unknown) => typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, value)
      : 0;

    review.href = destination;

    if (!isReader) {
      document.querySelectorAll<HTMLAnchorElement>(".doc__title").forEach((link) => {
        link.addEventListener("click", (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
          }

          saveNavigation(returnKey, {
            documentPath: link.pathname,
            listPath: currentList,
            scrollY: window.scrollY,
          });
        });
      });

      const receipt = readNavigation(receiptKey);
      const notice = document.querySelector("[data-deletion-notice]");

      if (
        receipt && listDestination(receipt.destination) === currentList &&
        typeof receipt.message === "string" && receipt.message.length <= 1000 &&
        notice instanceof HTMLElement
      ) {
        notice.textContent = receipt.message;
        notice.hidden = false;

        const next = Array.from(document.querySelectorAll<HTMLAnchorElement>(".doc__title"))
          .find((link) => link.pathname === receipt.focusPath);
        const focus = next ?? document.querySelector<HTMLInputElement>("#document-search");
        focus?.focus({ preventScroll: true });
        window.scrollTo(0, scrollPosition(receipt.scrollY));
      }
    }

    let selected: HTMLButtonElement | undefined;
    let restoreFocus: HTMLElement | undefined;
    let isDeleting = false;

    const closeDialog = () => {
      if (isDeleting) {
        return;
      }

      dialog.close();
    };

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener("close", () => restoreFocus?.focus({ preventScroll: true }));
    cancel.addEventListener("click", closeDialog);

    document.querySelectorAll<HTMLButtonElement>("[data-delete-document]").forEach((button) => {
      button.addEventListener("click", () => {
        if (dialog.open || isDeleting) {
          return;
        }

        selected = button;
        const menu = button.closest("details");
        restoreFocus = menu?.querySelector("summary") ?? button;

        if (menu instanceof HTMLDetailsElement) {
          menu.open = false;
        }

        title.textContent = button.dataset.documentTitle ?? "";
        file.textContent = button.dataset.documentFile ?? "";
        inbox.textContent = button.dataset.inboxName ?? "";
        error.hidden = true;
        progress.hidden = true;
        review.hidden = true;
        cancel.textContent = "Cancel";
        confirm.disabled = false;
        dialog.showModal();
        cancel.focus();
      });
    });

    const finishDeletion = (button: HTMLButtonElement, message: string) => {
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".doc__title"));
      const index = links.findIndex((link) => link.pathname === button.dataset.documentPath);
      const next = links[index + 1] ?? links[index - 1];

      saveNavigation(receiptKey, {
        destination,
        message,
        focusPath: next?.pathname,
        scrollY: isReader ? scrollPosition(returnContext?.scrollY) : window.scrollY,
      });

      // Replace the reader URL so Back cannot reopen a document just removed here.
      if (isReader) {
        window.location.replace(destination);
      } else {
        window.location.reload();
      }
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (isDeleting || !selected || confirm.disabled) {
        return;
      }

      const button = selected;
      const documentTitle = button.dataset.documentTitle ?? "Document";
      const inboxName = button.dataset.inboxName ?? "Inbox";
      isDeleting = true;
      cancel.disabled = true;
      confirm.disabled = true;
      dialog.setAttribute("aria-busy", "true");
      progress.textContent = "Deleting document. Please wait.";
      progress.hidden = false;
      error.hidden = true;
      review.hidden = true;

      let message = "We couldn't confirm whether the document was deleted. Check the inbox before trying again.";
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await window.fetch(button.dataset.deleteUrl ?? "", {
          method: "DELETE",
          headers: { "X-HTML-Inbox-CSRF": token },
          credentials: "same-origin",
          signal: controller.signal,
        });

        if (response.status === 204 || response.status === 404) {
          finishDeletion(button, response.status === 204
            ? `"${documentTitle}" was deleted from "${inboxName}".`
            : `"${documentTitle}" is already absent from "${inboxName}".`);
          return;
        }

        if (response.status === 200) {
          const result: unknown = await response.json();

          if (
            result && typeof result === "object" &&
            "status" in result && result.status === "removed" &&
            "cleanup" in result && result.cleanup === "failed"
          ) {
            finishDeletion(button, `"${documentTitle}" was removed from "${inboxName}", but some saved files could not be cleaned up. Check the inbox folder for leftover files.`);
            return;
          }
        } else if (response.status === 403) {
          message = "This page can no longer delete documents. Reload the page and try again.";
        } else if (response.status === 409) {
          message = "This inbox has changed since it was opened. Reload the inbox before trying again.";
        } else if (response.status < 500) {
          message = "The request could not be completed. Check the inbox and reload the page before trying again.";
        }
      } catch {} finally {
        window.clearTimeout(timeout);
      }

      isDeleting = false;
      dialog.removeAttribute("aria-busy");
      progress.hidden = true;
      error.textContent = message;
      error.hidden = false;
      review.hidden = false;
      cancel.disabled = false;
      cancel.textContent = "Close";
      cancel.focus();
    });
  };

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

    initializeDeletion();

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
