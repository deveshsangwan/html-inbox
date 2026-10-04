import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { parse } from "parse5";

const script = await readFile("site/assets/theme.js", "utf8");
const storageKey = "html-inbox-site-theme";

function loadPage({
  storage = new Map(),
  systemDark = false,
  blockedStorage = false,
  blockedWrites = false,
  hasMediaQuery = true,
} = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const mediaListeners = new Map();
  const buttonListeners = new Map();
  const root = { dataset: {} };
  const metadata = new Map();
  const label = { textContent: "Dark mode" };
  const button = {
    hidden: true,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    querySelector(selector) {
      assert.equal(selector, "[data-theme-label]");
      return label;
    },
    addEventListener(name, listener) {
      buttonListeners.set(name, listener);
    },
  };
  const localStorage = {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (blockedWrites) {
        throw new Error("Storage writes are disabled");
      }

      storage.set(key, value);
    },
  };
  const media = {
    matches: systemDark,
    addEventListener(name, listener) {
      mediaListeners.set(name, listener);
    },
  };
  const document = {
    documentElement: root,
    readyState: "loading",
    querySelector(selector) {
      assert.equal(selector, 'meta[name="theme-color"]');
      return {
        setAttribute(name, value) {
          metadata.set(name, value);
        },
      };
    },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-theme-toggle]");
      return this.readyState === "loading" ? [] : [button];
    },
    addEventListener(name, listener) {
      documentListeners.set(name, listener);
    },
  };
  const window = {
    get localStorage() {
      if (blockedStorage) {
        throw new Error("Storage access is disabled");
      }

      return localStorage;
    },
    ...(hasMediaQuery
      ? {
          matchMedia() {
            return media;
          },
        }
      : {}),
    addEventListener(name, listener) {
      windowListeners.set(name, listener);
    },
  };
  vm.runInNewContext(script, { window, document }, { timeout: 1000 });

  return {
    root,
    metadata,
    button,
    label,
    localStorage,
    ready() {
      document.readyState = "complete";
      documentListeners.get("DOMContentLoaded")();
    },
    click() {
      buttonListeners.get("click")();
    },
    systemChanges(isDark) {
      media.matches = isDark;
      mediaListeners.get("change")?.();
    },
    storageChanges(newValue, key = storageKey, storageArea = localStorage) {
      windowListeners.get("storage")({ key, newValue, storageArea });
    },
  };
}

test("system dark theme is applied before page controls are parsed", () => {
  const page = loadPage({ systemDark: true });
  assert.equal(page.root.dataset.theme, "dark");
  assert.equal(page.metadata.get("content"), "#101827");
  assert.equal(page.button.hidden, true);

  page.ready();
  assert.equal(page.button.hidden, false);
  assert.equal(page.label.textContent, "Light mode");
  assert.equal(
    page.button.attributes.get("aria-label"),
    "Switch to light mode",
  );
});

test("saved light and dark choices override the opposite system theme", () => {
  for (const theme of ["light", "dark"]) {
    const page = loadPage({
      storage: new Map([[storageKey, theme]]),
      systemDark: theme === "light",
    });
    assert.equal(page.root.dataset.theme, theme);
  }

  const page = loadPage({
    storage: new Map([[storageKey, "invalid"]]),
    systemDark: true,
  });
  assert.equal(page.root.dataset.theme, "dark");
});

test("both toggle directions persist across landing and documentation navigation", () => {
  const storage = new Map();
  const landing = loadPage({ storage });
  landing.ready();
  landing.click();
  assert.equal(landing.root.dataset.theme, "dark");
  assert.equal(storage.get(storageKey), "dark");
  assert.equal(landing.button.title, "Switch to light mode");

  const guide = loadPage({ storage });
  assert.equal(guide.root.dataset.theme, "dark");
  guide.ready();
  guide.click();
  assert.equal(guide.root.dataset.theme, "light");
  assert.equal(guide.metadata.get("content"), "#f8fafc");
  assert.equal(guide.label.textContent, "Dark mode");
  assert.equal(
    loadPage({ storage, systemDark: true }).root.dataset.theme,
    "light",
  );
});

test("system changes apply until the visitor makes an explicit choice", () => {
  const page = loadPage();
  page.ready();
  page.systemChanges(true);
  assert.equal(page.root.dataset.theme, "dark");

  page.click();
  page.systemChanges(false);
  page.systemChanges(true);
  assert.equal(page.root.dataset.theme, "light");
});

test("blocked preference access or writes never prevent switching the page", () => {
  for (const options of [{ blockedStorage: true }, { blockedWrites: true }]) {
    const page = loadPage(options);
    page.ready();
    page.click();
    page.systemChanges(false);
    assert.equal(page.root.dataset.theme, "dark");

    page.click();
    assert.equal(page.root.dataset.theme, "light");
  }
});

test("other tabs update the choice while unrelated storage leaves it alone", () => {
  const page = loadPage({ systemDark: true });
  page.ready();
  page.storageChanges("light");
  assert.equal(page.root.dataset.theme, "light");
  assert.equal(page.label.textContent, "Dark mode");

  page.storageChanges("dark", "another-site-theme");
  page.storageChanges("dark", storageKey, {});
  assert.equal(page.root.dataset.theme, "light");

  page.storageChanges(null, null);
  assert.equal(page.root.dataset.theme, "dark");
  page.storageChanges("invalid");
  page.systemChanges(false);
  assert.equal(page.root.dataset.theme, "light");
});

test("a missing system-preference API falls back to a working light theme", () => {
  const page = loadPage({ hasMediaQuery: false });
  page.ready();
  assert.equal(page.root.dataset.theme, "light");

  page.click();
  assert.equal(page.root.dataset.theme, "dark");
});

function collectElements(node, elements = []) {
  if (node.tagName) {
    elements.push(node);
  }

  for (const child of node.childNodes ?? []) {
    collectElements(child, elements);
  }

  return elements;
}

function attribute(element, name) {
  return element.attrs.find((item) => item.name === name)?.value;
}

test("every page loads the same theme before CSS and provides a native header button", async () => {
  const pages = [
    "site/index.html",
    ...(await readdir("site/docs"))
      .filter((name) => name.endsWith(".html"))
      .map((name) => `site/docs/${name}`),
  ];
  for (const filename of pages) {
    const elements = collectElements(parse(await readFile(filename, "utf8")));
    const themes = elements.filter(
      (element) =>
        element.tagName === "script" &&
        attribute(element, "src")?.endsWith("/theme.js"),
    );
    assert.equal(themes.length, 1, filename);
    const [theme] = themes;
    assert.equal(theme.parentNode.tagName, "head", filename);
    assert.equal(attribute(theme, "async"), undefined, filename);
    assert.equal(attribute(theme, "defer"), undefined, filename);
    assert.ok(
      elements.indexOf(theme) <
        elements.findIndex(
          (element) =>
            element.tagName === "link" &&
            attribute(element, "rel") === "stylesheet",
        ),
      filename,
    );

    const buttons = elements.filter(
      (element) => attribute(element, "data-theme-toggle") !== undefined,
    );
    assert.equal(buttons.length, 1, filename);
    const [button] = buttons;
    assert.equal(button.tagName, "button", filename);
    assert.equal(attribute(button, "type"), "button", filename);
    assert.equal(attribute(button, "hidden"), "", filename);
    const header = elements.find((element) => element.tagName === "header");
    assert.ok(header && collectElements(header).includes(button), filename);
    assert.ok(
      collectElements(button).some(
        (element) => attribute(element, "data-theme-label") !== undefined,
      ),
      filename,
    );
    assert.ok(
      elements.some(
        (element) =>
          element.tagName === "meta" &&
          attribute(element, "name") === "color-scheme" &&
          attribute(element, "content") === "light dark",
      ),
      filename,
    );
  }
});

function luminance(color) {
  const channels = color
    .slice(1)
    .match(/../g)
    .map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test("both palettes keep readable text, links, and action labels", async () => {
  const css = await readFile("site/assets/site.css", "utf8");
  const tokens = (declarations) =>
    Object.fromEntries(
      [...declarations.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(
        (match) => [match[1], match[2]],
      ),
    );
  const light = tokens(css.match(/:root\s*\{([^}]+)\}/s)[1]);
  const dark = {
    ...light,
    ...tokens(css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/s)[1]),
  };
  for (const [theme, palette] of Object.entries({ light, dark })) {
    const pairs = ["canvas", "surface", "accent-soft"].flatMap((background) =>
      ["ink", "muted", "accent"].map((foreground) => [foreground, background]),
    );
    pairs.push(["on-accent", "accent"], ["on-accent", "accent-hover"]);
    for (const [foreground, background] of pairs) {
      const values = [
        luminance(palette[foreground]),
        luminance(palette[background]),
      ];
      const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
      assert.ok(
        ratio >= 4.5,
        `${theme}: ${foreground} on ${background} contrast ${ratio.toFixed(2)}`,
      );
    }
  }
});
