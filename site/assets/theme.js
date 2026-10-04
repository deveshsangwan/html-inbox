(() => {
  const storageKey = "html-inbox-site-theme";
  const root = document.documentElement;
  const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");

  function isTheme(value) {
    return value === "light" || value === "dark";
  }

  function readPreference() {
    try {
      const value = window.localStorage.getItem(storageKey);
      return isTheme(value) ? value : null;
    } catch {
      return null;
    }
  }

  function getPreferredTheme() {
    return preference ?? (systemTheme?.matches ? "dark" : "light");
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#101827" : "#f8fafc");

    const action = theme === "dark" ? "light" : "dark";
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.hidden = false;
      button.setAttribute("aria-label", `Switch to ${action} mode`);
      button.title = `Switch to ${action} mode`;
      button.querySelector("[data-theme-label]").textContent =
        action === "dark" ? "Dark mode" : "Light mode";
    }
  }

  function connectToggles() {
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.addEventListener("click", () => {
        preference = root.dataset.theme === "dark" ? "light" : "dark";
        applyTheme(preference);

        try {
          window.localStorage.setItem(storageKey, preference);
        } catch {
          // A blocked preference store must not prevent switching this page.
        }
      });
    }

    applyTheme(getPreferredTheme());
  }

  let preference = readPreference();
  // Apply the choice before stylesheets load so a dark page never flashes light.
  applyTheme(getPreferredTheme());

  systemTheme?.addEventListener?.("change", () => {
    if (preference === null) {
      applyTheme(getPreferredTheme());
    }
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) {
      return;
    }

    try {
      if (event.storageArea && event.storageArea !== window.localStorage) {
        return;
      }
    } catch {
      return;
    }

    preference = isTheme(event.newValue) ? event.newValue : null;
    applyTheme(getPreferredTheme());
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connectToggles, {
      once: true,
    });
  } else {
    connectToggles();
  }
})();
