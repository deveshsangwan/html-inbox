import { timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSafeDocumentId } from "./documents";
import { DocumentCleanupError, DocumentIdentityError, type DocumentDeleter } from "./document-deletion";
import type { ViewerNetworkConfig } from "./viewer-network";

type DeletionTarget = { deleteDocument?: DocumentDeleter } | {
  mounts: readonly { name: string; deleteDocument?: DocumentDeleter }[];
};

export function createViewerDocumentDeletion(target: DeletionTarget) {
  const hasWriter = "mounts" in target
    ? target.mounts.some((mount) => mount.deleteDocument)
    : Boolean(target.deleteDocument);

  if (!hasWriter) {
    return undefined;
  }

  const token = randomBytes(32).toString("base64url");

  return {
    token,
    async handle(request: IncomingMessage, response: ServerResponse, config: ViewerNetworkConfig) {
      if (request.method !== "DELETE") {
        response.setHeader("Allow", "DELETE");
        sendResult(response, 405, "Method Not Allowed");
        return;
      }

      if (!isAuthorizedRequest(request, config, token)) {
        sendResult(response, 403, "Refresh the inbox before trying to delete again.");
        return;
      }

      if (request.headers["transfer-encoding"] !== undefined ||
          (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
        sendResult(response, 400, "Deletion requests must have an empty body.");
        return;
      }

      const match = "mounts" in target
        ? /^\/api\/sources\/([a-zA-Z0-9_-]+)\/documents\/([a-zA-Z0-9_-]+)$/.exec(request.url ?? "")
        : /^\/api\/documents\/([a-zA-Z0-9_-]+)$/.exec(request.url ?? "");
      const id = "mounts" in target ? match?.[2] : match?.[1];
      const deleteDocument = "mounts" in target
        ? target.mounts.find((mount) => mount.name === match?.[1])?.deleteDocument
        : target.deleteDocument;

      if (!id || !isSafeDocumentId(id) || !deleteDocument) {
        sendResult(response, 404, "Document not found.");
        return;
      }

      try {
        const result = await deleteDocument(id);

        if (!result) {
          sendResult(response, 404, "This document is no longer available.");
          return;
        }

        response.writeHead(204, resultHeaders());
        response.end();
      } catch (error) {
        console.error("html-inbox: Document deletion failed:", error);

        if (error instanceof DocumentCleanupError) {
          response.writeHead(200, { ...resultHeaders(), "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ status: "removed", cleanup: "failed" }));
          return;
        }

        if (error instanceof DocumentIdentityError) {
          sendResult(response, 409, "The inbox is unavailable or has changed. Restart its viewer or hub before deleting.");
          return;
        }

        sendResult(response, 500, "Deletion could not be confirmed. Refresh the inbox before trying again.");
      }
    },
  };
}

export function hasSingleHeader(request: IncomingMessage, name: string): boolean {
  let count = 0;

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) {
      count += 1;
    }
  }

  return count === 1;
}

function isAuthorizedRequest(request: IncomingMessage, config: ViewerNetworkConfig, token: string): boolean {
  if (!hasSingleHeader(request, "origin") || !hasSingleHeader(request, "x-html-inbox-csrf")) {
    return false;
  }

  const suppliedToken = request.headers["x-html-inbox-csrf"];
  const origin = request.headers.origin;
  const host = request.headers.host;

  if (typeof suppliedToken !== "string" || suppliedToken.length !== token.length ||
      !/^[a-zA-Z0-9_-]+$/.test(suppliedToken) || !origin || !host) {
    return false;
  }

  const expectedOrigin = config.exposure === "tailscale" &&
      (host.toLowerCase() === config.tailscaleHostname || host.toLowerCase() === `${config.tailscaleHostname}:443`)
    ? `https://${config.tailscaleHostname}`
    : new URL(`http://${host}`).origin;

  return origin === expectedOrigin && timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(token));
}

function resultHeaders() {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendResult(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { ...resultHeaders(), "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}
