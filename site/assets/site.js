function selectCommand(command, status) {
  const selection = window.getSelection();

  if (!selection) {
    status.textContent =
      "Copy is unavailable. Select the command and copy it manually.";
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(command);
  selection.removeAllRanges();
  selection.addRange(range);
  status.textContent =
    "The command is selected. Copy it with your keyboard or selection menu.";
}

function enhanceCopyButtons() {
  const buttons = document.querySelectorAll("[data-copy-target]");

  for (const button of buttons) {
    const command = document.getElementById(button.dataset.copyTarget);
    const status =
      document.getElementById(button.dataset.copyStatus ?? "") ??
      button.closest(".command")?.querySelector(".copy-status");

    if (!command || !status) {
      continue;
    }

    const originalLabel = button.textContent.trim();
    button.hidden = false;
    button.addEventListener("click", async () => {
      const commandText = command.textContent.trim();

      if (!commandText) {
        return;
      }

      button.textContent = originalLabel;

      try {
        if (!navigator.clipboard?.writeText) {
          selectCommand(command, status);
          return;
        }

        await navigator.clipboard.writeText(commandText);
        button.textContent = "Copied";
        status.textContent = "Command copied to clipboard.";
      } catch {
        selectCommand(command, status);
      }
    });
  }
}

function enhanceExampleInbox() {
  const example = document.getElementById("example");
  const search = document.getElementById("example-search");
  const count = document.getElementById("example-count");

  if (!example || !search || !count) {
    return;
  }

  const rows = [...example.querySelectorAll("[data-demo-search-text]")];
  const links = [...example.querySelectorAll("[data-demo-document]")];
  const panels = [...example.querySelectorAll("[data-demo-panel]")];
  const empty = example.querySelector("[data-demo-empty]");
  const status = example.querySelector("[data-demo-status]");
  const searchControl = example.querySelector("[data-demo-search]");

  if (!rows.length || !panels.length || !empty || !status || !searchControl) {
    return;
  }

  function showDocument(documentId, announce = true) {
    const selectedPanel = panels.find((panel) => panel.id === documentId);

    if (!selectedPanel) {
      return;
    }

    for (const panel of panels) {
      panel.hidden = panel !== selectedPanel;
      panel.open = panel === selectedPanel;
    }

    for (const link of links) {
      if (link.dataset.demoDocument === documentId) {
        link.setAttribute("aria-current", "true");
      } else {
        link.removeAttribute("aria-current");
      }
    }

    if (announce) {
      const title = selectedPanel.querySelector("summary")?.textContent;
      status.textContent = `Previewing ${title ?? "the selected document"}.`;
    }
  }

  const linkedPanel = panels.find(
    (panel) => panel.id === window.location.hash.slice(1),
  );
  searchControl.hidden = false;
  showDocument(
    linkedPanel?.id ?? panels.find((panel) => panel.open)?.id ?? panels[0].id,
    false,
  );

  window.addEventListener("hashchange", () => {
    showDocument(window.location.hash.slice(1), false);
  });

  for (const link of links) {
    link.addEventListener("click", (event) => {
      if (
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      event.preventDefault();
      showDocument(link.dataset.demoDocument);
    });
  }

  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    let visibleCount = 0;

    for (const row of rows) {
      const matches = row.dataset.demoSearchText.includes(query);
      row.hidden = !matches;

      if (matches) {
        visibleCount += 1;
      }
    }

    empty.hidden = visibleCount !== 0;
    count.textContent = query
      ? `${visibleCount} of ${rows.length} documents`
      : `${rows.length} documents`;
  });
}

enhanceCopyButtons();
enhanceExampleInbox();
