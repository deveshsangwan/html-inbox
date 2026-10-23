import { TextDecoder } from "node:util";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { getMaxDocumentBytes } from "./publish-input";

export const MAX_DOCUMENT_COPY_JSON_BYTES = 10 * 1024 * 1024;

export type DocumentCopyPayload = {
  schemaVersion: 1;
  status: "ready";
  text: string;
  codeBlocks: string[];
} | {
  schemaVersion: 1;
  status: "unavailable";
  reason: "too-large" | "invalid-encoding";
};

const OMITTED_ELEMENTS = new Set(["head", "script", "style", "template", "noscript"]);
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "caption", "dd", "details", "dialog",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main",
  "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead",
  "tr", "ul",
]);

interface TraversalFrame {
  element: DefaultTreeAdapterMap["element"];
  childIndex: number;
  preservesWhitespace: boolean;
  startsCodeBlock: boolean;
  separator?: string;
}

export function extractDocumentCopyContent(
  originalBytes: Buffer,
  maximumDocumentBytes = getMaxDocumentBytes(),
): DocumentCopyPayload {
  if (originalBytes.byteLength > maximumDocumentBytes) {
    return { schemaVersion: 1, status: "unavailable", reason: "too-large" };
  }

  let html: string;

  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(originalBytes);
  } catch {
    return { schemaVersion: 1, status: "unavailable", reason: "invalid-encoding" };
  }

  const document = parse(html);
  const root = document.childNodes.find((node) => "tagName" in node && node.tagName === "html");
  const body = root && "childNodes" in root
    ? root.childNodes.find((node) => "tagName" in node && node.tagName === "body")
    : undefined;
  const textParts: string[] = [];
  const codeBlocks: string[] = [];
  let codeBlockParts: string[] | undefined;
  let pendingSeparator = "";
  let encodedBytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, status: "ready", text: "", codeBlocks: [] }));
  let isTooLarge = false;

  const appendText = (value: string, includeInCodeBlock = false) => {
    if (!value) {
      return;
    }

    const copies = includeInCodeBlock && codeBlockParts ? 2 : 1;
    encodedBytes += (Buffer.byteLength(JSON.stringify(value)) - 2) * copies;

    if (encodedBytes > MAX_DOCUMENT_COPY_JSON_BYTES) {
      isTooLarge = true;
      return;
    }

    textParts.push(value);

    if (includeInCodeBlock) {
      codeBlockParts?.push(value);
    }
  };

  const separateText = (separator: string) => {
    if (!textParts.length || pendingSeparator === "\n" || (separator === " " && pendingSeparator)) {
      return;
    }

    pendingSeparator = separator;
  };

  const flushSeparator = () => {
    if (pendingSeparator !== "\n" || !textParts[textParts.length - 1]?.endsWith("\n")) {
      appendText(pendingSeparator);
    }

    pendingSeparator = "";
  };

  const appendOrdinaryText = (value: string) => {
    const collapsed = value.replace(/[\t\n\f\r ]+/g, " ");
    const content = collapsed.replace(/^ | $/g, "");

    if (collapsed.startsWith(" ")) {
      separateText(" ");
    }

    if (content) {
      flushSeparator();
      appendText(content);
    }

    if (collapsed.endsWith(" ")) {
      separateText(" ");
    }
  };

  const frames: TraversalFrame[] = [];

  if (body && "tagName" in body && root && "tagName" in root && !isOmittedElement(root) && !isOmittedElement(body)) {
    frames.push({ element: body, childIndex: 0, preservesWhitespace: false, startsCodeBlock: false });
  }

  // Keep one frame per ancestor so wide and deeply nested documents do not use the call stack.
  while (frames.length && !isTooLarge) {
    const frame = frames[frames.length - 1];
    const node = frame.element.childNodes[frame.childIndex++];

    if (!node) {
      if (frame.startsCodeBlock) {
        codeBlocks.push(codeBlockParts?.join("") ?? "");
        codeBlockParts = undefined;
      }

      if (frame.separator) {
        separateText(frame.separator);
      }

      frames.pop();
      continue;
    }

    if ("value" in node) {
      if (frame.preservesWhitespace) {
        flushSeparator();
        appendText(node.value, true);
      } else {
        appendOrdinaryText(node.value);
      }

      continue;
    }

    if (!("tagName" in node) || isOmittedElement(node)) {
      continue;
    }

    if (node.tagName === "br") {
      pendingSeparator = "";
      appendText("\n", frame.preservesWhitespace);
      continue;
    }

    const separator = !frame.preservesWhitespace && BLOCK_ELEMENTS.has(node.tagName)
      ? "\n"
      : undefined;

    if (separator) {
      separateText(separator);
    }

    const startsCodeBlock = node.tagName === "pre" && codeBlockParts === undefined;

    if (startsCodeBlock) {
      encodedBytes += codeBlocks.length ? 3 : 2;
      codeBlockParts = [];
    }

    frames.push({
      element: node,
      childIndex: 0,
      preservesWhitespace: frame.preservesWhitespace || node.tagName === "pre" || node.tagName === "code",
      startsCodeBlock,
      separator: separator ?? (!frame.preservesWhitespace && (node.tagName === "td" || node.tagName === "th") ? "\t" : undefined),
    });
    isTooLarge = encodedBytes > MAX_DOCUMENT_COPY_JSON_BYTES;
  }

  if (isTooLarge) {
    return { schemaVersion: 1, status: "unavailable", reason: "too-large" };
  }

  return { schemaVersion: 1, status: "ready", text: textParts.join(""), codeBlocks };
}

function isOmittedElement(element: DefaultTreeAdapterMap["element"]): boolean {
  return OMITTED_ELEMENTS.has(element.tagName) || element.attrs.some((attribute) => attribute.name === "hidden");
}
