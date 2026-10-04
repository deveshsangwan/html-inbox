import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "parse5";

const siteDirectory = path.resolve("site");
const siteOrigin = "https://site.test";
const sitePrefix = "/html-inbox/";
const pages = new Map();
const failures = [];

async function collectPages(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectPages(filename);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".html")) {
      continue;
    }

    const relative = path.relative(siteDirectory, filename).split(path.sep).join("/");
    const errors = [];
    const document = parse(await readFile(filename, "utf8"), {
      onParseError: error => errors.push(error.code),
    });
    const elements = [];
    visitElements(document, elements);
    const ids = new Set();
    for (const element of elements) {
      const id = attribute(element, "id");
      if (id && ids.has(id)) {
        failures.push(`${relative}: duplicate ID ${id}`);
      }

      if (id) {
        ids.add(id);
      }
    }

    if (errors.length) {
      failures.push(`${relative}: HTML parse errors: ${errors.join(", ")}`);
    }

    for (const tag of ["title", "h1", "main"]) {
      if (elements.filter(element => element.tagName === tag).length !== 1) {
        failures.push(`${relative}: expected one ${tag} element`);
      }
    }

    const html = elements.find(element => element.tagName === "html");
    if (!html || !attribute(html, "lang")) {
      failures.push(`${relative}: missing document language`);
    }

    if (!elements.some(element => element.tagName === "meta" && attribute(element, "name") === "viewport")) {
      failures.push(`${relative}: missing viewport metadata`);
    }

    pages.set(relative, { elements, ids });
  }
}

function visitElements(node, elements) {
  if (node.tagName) {
    elements.push(node);
  }

  for (const child of node.childNodes ?? []) {
    visitElements(child, elements);
  }

  if (node.content) {
    visitElements(node.content, elements);
  }
}

function attribute(element, name) {
  return element.attrs.find(item => item.name === name)?.value;
}

async function verifyReference(page, reference) {
  if (!reference || /^(?:https?:|mailto:|tel:|data:)/i.test(reference)) {
    return;
  }

  const url = new URL(reference, `${siteOrigin}${sitePrefix}${page}`);
  if (url.origin !== siteOrigin || !url.pathname.startsWith(sitePrefix)) {
    failures.push(`${page}: reference escapes the GitHub Pages project path: ${reference}`);
    return;
  }

  const relative = decodeURIComponent(url.pathname.slice(sitePrefix.length));
  const target = relative.endsWith("/") || !relative ? `${relative}index.html` : relative;
  const filename = path.resolve(siteDirectory, target);
  if (!filename.startsWith(`${siteDirectory}${path.sep}`)) {
    failures.push(`${page}: reference escapes the website directory: ${reference}`);
    return;
  }

  try {
    if (!(await stat(filename)).isFile()) {
      failures.push(`${page}: reference is not a file: ${reference}`);
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    failures.push(`${page}: missing reference: ${reference}`);
    return;
  }

  if (url.hash && pages.has(target) && !pages.get(target).ids.has(decodeURIComponent(url.hash.slice(1)))) {
    failures.push(`${page}: missing fragment: ${reference}`);
  }
}

await collectPages(siteDirectory);
for (const [page, { elements }] of pages) {
  for (const element of elements) {
    for (const name of ["href", "src"]) {
      await verifyReference(page, attribute(element, name));
    }

    if (element.tagName === "img" && attribute(element, "alt") === undefined) {
      failures.push(`${page}: image missing alt attribute`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Website integrity passed for ${pages.size} HTML pages: headings, language, metadata, IDs, links, fragments, and assets under the GitHub Pages project path.`);
}
