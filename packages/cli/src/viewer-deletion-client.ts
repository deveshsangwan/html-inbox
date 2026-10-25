export function initializeDocumentDeletion(): void {
  const initialize = () => {
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
    const heading = dialog.querySelector("h2");
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
        const saved = JSON.stringify(value);
        window.sessionStorage.setItem(key, saved);

        return window.sessionStorage.getItem(key) === saved;
      } catch {
        return false;
      }
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
        const restorePosition = () => window.requestAnimationFrame(() => {
          focus?.focus({ preventScroll: true });
          window.scrollTo(0, scrollPosition(receipt.scrollY));
        });

        if (document.readyState === "complete") {
          restorePosition();
        } else {
          window.addEventListener("load", restorePosition, { once: true });
        }
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

        if (heading) {
          heading.textContent = "Delete document?";
        }

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

      const hasSavedNotice = saveNavigation(receiptKey, {
        destination,
        message,
        focusPath: next?.pathname,
        scrollY: isReader ? scrollPosition(returnContext?.scrollY) : window.scrollY,
      });

      if (!hasSavedNotice) {
        isDeleting = false;
        dialog.removeAttribute("aria-busy");
        progress.textContent = message;
        progress.hidden = false;
        review.hidden = false;
        cancel.disabled = false;
        cancel.textContent = "Close";
        button.disabled = true;

        if (heading) {
          heading.textContent = "Document removed";
        }

        cancel.focus();
        return;
      }

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
            finishDeletion(button, `"${documentTitle}" was removed from "${inboxName}", but some saved files could not be cleaned up.`);
            return;
          }
        } else if (response.status === 403) {
          message = "This page can no longer delete documents. Reload the page and try again.";
        } else if (response.status === 409) {
          message = "This inbox has changed or is unavailable. Restart its viewer or hub before deleting.";
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

  document.addEventListener("DOMContentLoaded", initialize, { once: true });
}
