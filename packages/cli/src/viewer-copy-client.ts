import type { DocumentCopyPayload } from "./document-copy";

// This initializer is serialized into viewer.js. Keep its runtime dependencies inside it.
export function initializeViewerCopy(maximumJsonBytes: number): void {
  const initialize = () => {
    const dialog = document.querySelector("[data-copy-dialog]");
    const openButton = document.querySelector("[data-copy-open]");
    const closeButton = document.querySelector("[data-copy-close]");
    const retryButton = document.querySelector("[data-copy-retry]");
    const content = document.querySelector("[data-copy-content]");
    const status = document.querySelector("[data-copy-status]");
    const format = document.querySelector("[data-copy-format]");
    const codeControls = document.querySelector("[data-copy-code-controls]");
    const codePicker = document.querySelector("[data-copy-code-block]");
    const empty = document.querySelector("[data-copy-empty]");
    const previewLabel = document.querySelector("[data-copy-preview-label]");
    const preview = document.querySelector("[data-copy-preview]");
    const copyAll = document.querySelector("[data-copy-all]");
    const copySelection = document.querySelector("[data-copy-selection]");
    const copyCode = document.querySelector("[data-copy-code]");
    const selectAll = document.querySelector("[data-copy-select-all]");
    const menu = openButton?.closest("[data-viewer-menu]");
    const summary = menu?.querySelector("summary");

    if (
      !(dialog instanceof HTMLDialogElement) ||
      !(openButton instanceof HTMLButtonElement) ||
      !(closeButton instanceof HTMLButtonElement) ||
      !(retryButton instanceof HTMLButtonElement) ||
      !(content instanceof HTMLElement) ||
      !(status instanceof HTMLElement) ||
      !(format instanceof HTMLSelectElement) ||
      !(codeControls instanceof HTMLElement) ||
      !(codePicker instanceof HTMLSelectElement) ||
      !(empty instanceof HTMLElement) ||
      !(previewLabel instanceof HTMLElement) ||
      !(preview instanceof HTMLTextAreaElement) ||
      !(copyAll instanceof HTMLButtonElement) ||
      !(copySelection instanceof HTMLButtonElement) ||
      !(copyCode instanceof HTMLButtonElement) ||
      !(selectAll instanceof HTMLButtonElement) ||
      !(menu instanceof HTMLDetailsElement) ||
      !(summary instanceof HTMLElement)
    ) {
      return;
    }

    const copyUrl = dialog.dataset.copyUrl;

    if (!copyUrl) {
      return;
    }

    let payload: Extract<DocumentCopyPayload, { status: "ready" }> | undefined;
    let preparation: AbortController | undefined;
    let generation = 0;
    let previewGeneration = 0;
    let isWritePending = false;
    let selectionStart = 0;
    let selectionEnd = 0;

    const isCurrent = (requestGeneration: number) => dialog.open && generation === requestGeneration;

    const preparedText = () => {
      if (!payload) {
        return "";
      }

      return format.value === "text" ? payload.text : payload.codeBlocks[Number(codePicker.value)] ?? "";
    };

    const hasSelection = () => format.value === "text" &&
      selectionStart >= 0 && selectionEnd > selectionStart && selectionEnd <= preview.value.length;

    const updateButtons = () => {
      const hasText = Boolean(payload && preparedText().length);
      copyAll.disabled = !hasText;
      copySelection.disabled = !hasText || !hasSelection();
      copyCode.disabled = !hasText;
      selectAll.disabled = !hasText;

      for (const button of [copyAll, copySelection, copyCode]) {
        // aria-disabled keeps the activated button focused while a write settles.
        button.setAttribute("aria-disabled", String(isWritePending));
      }
    };

    const rememberSelection = () => {
      selectionStart = preview.selectionStart;
      selectionEnd = preview.selectionEnd;
      updateButtons();
    };

    const showPreview = () => {
      previewGeneration += 1;
      const isCode = format.value === "code";
      const blockNumber = Number(codePicker.value) + 1;
      const hasCodeBlocks = Boolean(payload?.codeBlocks.length);
      codeControls.hidden = !isCode || !hasCodeBlocks;
      copyAll.hidden = isCode;
      copySelection.hidden = isCode;
      copyCode.hidden = !isCode;
      copyCode.textContent = `Copy code block ${blockNumber}`;
      previewLabel.textContent = isCode ? `Code block ${blockNumber}` : "Document text";
      preview.value = preparedText();
      preview.wrap = isCode ? "off" : "soft";
      selectionStart = 0;
      selectionEnd = 0;

      empty.textContent = isCode
        ? hasCodeBlocks ? `Code block ${blockNumber} is empty.` : "No code blocks found in the saved HTML."
        : "No document text found in the saved HTML.";
      empty.hidden = preview.value.length > 0;
      preview.hidden = isCode && !hasCodeBlocks;
      previewLabel.hidden = preview.hidden;
      updateButtons();
      status.textContent = "Content ready. Choose what to copy.";
    };

    const validatePayload = (value: unknown): DocumentCopyPayload => {
      if (typeof value !== "object" || value === null ||
        !("schemaVersion" in value) || value.schemaVersion !== 1 || !("status" in value)) {
        throw new Error("Invalid copy content");
      }

      if (value.status === "ready" && "text" in value && typeof value.text === "string" &&
        "codeBlocks" in value && Array.isArray(value.codeBlocks) &&
        value.codeBlocks.every((block: unknown) => typeof block === "string")) {
        return { schemaVersion: 1, status: "ready", text: value.text, codeBlocks: value.codeBlocks };
      }

      if (value.status === "unavailable" && "reason" in value &&
        (value.reason === "too-large" || value.reason === "invalid-encoding")) {
        return { schemaVersion: 1, status: "unavailable", reason: value.reason };
      }

      throw new Error("Invalid copy content");
    };

    const fetchPayload = async (signal: AbortSignal) => {
      const response = await fetch(copyUrl, { signal, cache: "no-store", mode: "same-origin", redirect: "error" });
      const mime = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();

      if (!response.ok || mime !== "application/json" || !response.body) {
        await response.body?.cancel();

        throw new Error("Invalid copy response");
      }

      if (Number(response.headers.get("Content-Length")) > maximumJsonBytes) {
        await response.body.cancel();

        throw new Error("too-large");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts = [];
      let bytesRead = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          bytesRead += value.byteLength;

          if (bytesRead > maximumJsonBytes) {
            throw new Error("too-large");
          }

          parts.push(decoder.decode(value, { stream: true }));
        }

        parts.push(decoder.decode());
      } catch (error) {
        await reader.cancel();

        throw error;
      } finally {
        reader.releaseLock();
      }

      const value: unknown = JSON.parse(parts.join(""));

      return validatePayload(value);
    };

    const resetPreparation = () => {
      generation += 1;
      preparation?.abort();
      preparation = undefined;
      payload = undefined;
      preview.value = "";
      selectionStart = 0;
      selectionEnd = 0;
      content.hidden = true;
      retryButton.hidden = true;
      codePicker.replaceChildren();
      updateButtons();
    };

    const prepareContent = async () => {
      resetPreparation();
      const requestGeneration = generation;
      const controller = new AbortController();
      preparation = controller;
      status.textContent = "Preparing content...";

      try {
        const result = await fetchPayload(controller.signal);

        if (!isCurrent(requestGeneration)) {
          return;
        }

        if (result.status === "unavailable") {
          status.textContent = result.reason === "too-large"
            ? "This saved HTML is too large to prepare for copying. Use native Copy in the preview."
            : "This saved HTML has invalid text encoding. Use native Copy in the preview.";

          return;
        }

        payload = result;

        result.codeBlocks.forEach((_block, index) => {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = `Code block ${index + 1}`;
          codePicker.append(option);
        });

        content.hidden = false;
        showPreview();
      } catch (error) {
        if (!isCurrent(requestGeneration)) {
          return;
        }

        status.textContent = error instanceof Error && error.message === "too-large"
          ? "Copy content is too large to prepare. Use native Copy in the preview."
          : "Could not prepare content. Retry, or use native Copy in the preview.";
        retryButton.hidden = false;
      }
    };

    const copyText = (text: string) => {
      if (!dialog.open || !payload || !text.length || isWritePending) {
        return;
      }

      const manualHelp = "Select text, then use Ctrl+C or Command+C, the context menu, or touch Copy.";

      if (typeof navigator.clipboard?.writeText !== "function") {
        status.textContent = `Clipboard copy is unavailable in this browser. ${manualHelp}`;

        return;
      }

      const writeGeneration = generation;
      const writePreviewGeneration = previewGeneration;
      isWritePending = true;
      updateButtons();
      status.textContent = "Copying...";

      const settleWrite = (message: string) => {
        isWritePending = false;
        updateButtons();

        if (isCurrent(writeGeneration) && previewGeneration === writePreviewGeneration) {
          status.textContent = message;
        }
      };

      try {
        // Invoke the API during this activation, before any asynchronous work.
        const write = navigator.clipboard.writeText(text);
        void write.then(
          () => settleWrite("Copied."),
          () => settleWrite(`Could not copy. ${manualHelp}`),
        );
      } catch {
        settleWrite(`Could not copy. ${manualHelp}`);
      }
    };

    const closeDialog = () => {
      resetPreparation();
      status.textContent = "";
      dialog.close();
      summary.focus({ preventScroll: true });
    };

    openButton.addEventListener("click", () => {
      menu.open = false;
      format.value = "text";
      dialog.showModal();
      closeButton.focus({ preventScroll: true });
      void prepareContent();
    });

    closeButton.addEventListener("click", closeDialog);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    retryButton.addEventListener("click", () => { void prepareContent(); });
    format.addEventListener("change", showPreview);
    codePicker.addEventListener("change", showPreview);
    preview.addEventListener("select", rememberSelection);
    preview.addEventListener("blur", rememberSelection);
    copySelection.addEventListener("pointerdown", rememberSelection);

    copyAll.addEventListener("click", () => copyText(preparedText()));
    copyCode.addEventListener("click", () => copyText(preparedText()));
    copySelection.addEventListener("click", () => {
      if (preview.selectionEnd > preview.selectionStart) {
        rememberSelection();
      }

      if (!hasSelection()) {
        return;
      }

      copyText(preview.value.slice(selectionStart, selectionEnd));
    });

    selectAll.addEventListener("click", () => {
      preview.focus({ preventScroll: true });
      preview.select();
      rememberSelection();
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
}
