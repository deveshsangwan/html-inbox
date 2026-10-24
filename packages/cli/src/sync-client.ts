import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { RouteAuthorization, SyncRoute, OriginState } from "./sync-model";
import { parseInteger, parseUuid, stateFingerprint, SYNC_DEFAULTS, SYNC_LIMITS } from "./sync-model";
import { ManagedSyncStore, type ApplyResult } from "./sync-store";
import { BINDING_HEADER, decodeJson, parseToken, SyncProtocolError, WIRE_LIMITS, type RequestBinding } from "./sync-wire";
import { parseRemoteFailure } from "./sync-failure";

export interface SyncCredentials {
  token: string;
  ca?: string | Buffer;
}

export type SyncCredentialResolver = (route: SyncRoute) => SyncCredentials;

export interface SyncRequestOptions {
  signal?: AbortSignal;
  requestMs?: number;
  deadlineAt?: number;
}

/** Only existing configured HTTPS routes can be contacted. Credentials and CA bytes stay in the caller's process. */
export class SyncClient {
  readonly peerId: string;
  readonly counters = { requests: 0, requestBytes: 0, responseBytes: 0 };

  constructor(private readonly store: ManagedSyncStore, peerId: string, private readonly credentials: SyncCredentialResolver) {
    this.peerId = parseUuid(peerId);
  }

  async json<T>(authorization: RouteAuthorization, endpoint: "identity" | "manifest" | "holdings" | "offer", envelope: unknown,
    parse: (value: unknown) => T, maximum: number, options: SyncRequestOptions = {}): Promise<T> {
    const body = Buffer.from(JSON.stringify(envelope));
    return this.request(authorization, "POST", `/sync/v1/${endpoint}`, body, "application/json", async (response) => {
      await this.checkResponse(response, "application/json");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response) {
        const owned = this.responseChunk(chunk);
        length += owned.length;
        if (length > maximum) {
          throw new SyncProtocolError(413, "response-limit");
        }

        chunks.push(owned);
      }

      return parse(decodeJson(Buffer.concat(chunks, length)));
    }, options);
  }

  async putBody(authorization: RouteAuthorization, transferId: string, state: OriginState, bytes: Buffer, options: SyncRequestOptions = {}): Promise<unknown> {
    const owned = Buffer.from(bytes);
    if (owned.length !== state.byteLength || owned.length > SYNC_LIMITS.htmlBytes) {
      throw new Error("Outgoing body length conflict");
    }

    return this.request(authorization, "PUT", `/sync/v1/body?transferId=${parseToken(transferId)}`, owned, "application/octet-stream", async (response) => {
      await this.checkResponse(response, "application/json");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response) {
        const owned = this.responseChunk(chunk);
        length += owned.length;
        if (length > WIRE_LIMITS.offer) {
          throw new SyncProtocolError(413, "response-limit");
        }

        chunks.push(owned);
      }

      return decodeJson(Buffer.concat(chunks, length));
    }, options, state);
  }

  async pullBody(authorization: RouteAuthorization, sessionId: string, state: OriginState, options: SyncRequestOptions = {}): Promise<ApplyResult> {
    const query = new URLSearchParams({ sessionId: parseToken(sessionId), originInboxId: state.originInboxId, originDocumentId: state.originDocumentId,
      fingerprint: stateFingerprint(state) });
    return this.request(authorization, "GET", `/sync/v1/body?${query}`, undefined, undefined, async (response) => {
      await this.checkResponse(response, "application/octet-stream");
      if (response.headers["content-length"] !== String(state.byteLength)) {
        throw new SyncProtocolError(409, "body-length-conflict");
      }

      const client = this;
      async function* chunks() {
        for await (const chunk of response) {
          yield client.responseChunk(chunk);
        }
      }

      return this.store.applyStream(authorization, state, chunks());
    }, options);
  }

  private async request<T>(authorization: RouteAuthorization, method: "POST" | "PUT" | "GET", requestPath: string, bytes: Buffer | undefined,
    contentType: string | undefined, consume: (response: IncomingMessage) => Promise<T>, options: SyncRequestOptions, expectedState?: OriginState): Promise<T> {
    const requestMs = parseInteger(options.requestMs ?? SYNC_DEFAULTS.attemptMs, 1, 60_000);
    const deadlineAt = Math.min(options.deadlineAt === undefined ? Date.now() + requestMs : parseInteger(options.deadlineAt, 1), Date.now() + requestMs);
    const attempt = await this.store.openRouteAttempt(authorization, options.signal, deadlineAt, true);
    const controller = new AbortController();
    const abort = () => controller.abort(new SyncProtocolError(503, "request-aborted"));
    attempt.signal.addEventListener("abort", abort, { once: true });
    if (attempt.signal.aborted) abort();
    const timer = setTimeout(abort, Math.max(1, deadlineAt - Date.now()));
    try {
      const started = await this.store.startCommunication(authorization, (route, local) => {
        controller.signal.throwIfAborted();
        if (Date.now() >= deadlineAt) {
          throw new SyncProtocolError(503, "request-deadline");
        }

        const credentials = this.credentials(route);
        const token = parseToken(credentials.token);
        const binding: RequestBinding = { protocolVersion: 1, routeId: route.id, revision: route.revision, callerPeerId: this.peerId, targetPeerId: route.peerId,
          sourceInboxId: route.sourceInboxId, destinationInboxId: route.destinationInboxId, callerStorageIncarnation: local.storageIncarnation };
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, [BINDING_HEADER]: Buffer.from(JSON.stringify(binding)).toString("base64url"),
          accept: "application/json", connection: "close", "accept-encoding": "identity" };
        if (bytes !== undefined) {
          headers["content-length"] = String(bytes.length);
          headers["content-type"] = contentType ?? "application/octet-stream";
        }

        const pending = new Promise<T>((resolve, reject) => {
          const request = https.request(new URL(requestPath, route.peerUrl), { method, headers, ca: credentials.ca, agent: false,
            minVersion: "TLSv1.2", rejectUnauthorized: true, maxHeaderSize: WIRE_LIMITS.headers, signal: controller.signal }, (response) => {
            consume(response).then(resolve, (error: unknown) => {
              reject(error instanceof SyncProtocolError || response.complete ? error : new SyncProtocolError(503, "response-truncated"));
            }).finally(() => response.destroy());
          });
          this.counters.requests += 1;
          request.setTimeout(Math.max(1, deadlineAt - Date.now()), abort);
          request.on("error", (error: unknown) => {
            const certificateErrors = ["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
              "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"];
            const isCertificateFailure = error instanceof Error && "code" in error && typeof error.code === "string" && certificateErrors.includes(error.code);
            reject(new SyncProtocolError(isCertificateFailure ? 403 : 503, controller.signal.aborted ? "request-deadline" :
              isCertificateFailure ? "tls-verification-failed" : "verified-transport-failed"));
          });
          if (bytes) {
            this.counters.requestBytes += bytes.length;
          }

          request.end(bytes);
        });
        // TLS can reject while asynchronous lock cleanup is still running.
        void pending.catch(() => {});
        return pending;
      }, expectedState, deadlineAt, true);
      return await started.value;
    } finally {
      clearTimeout(timer);
      attempt.signal.removeEventListener("abort", abort);
      attempt.close();
    }
  }

  private async checkResponse(response: IncomingMessage, contentType: string): Promise<void> {
    if (response.statusCode !== 200) {
      const status = response.statusCode ?? 503;
      const invalidEnvelope = () => new SyncProtocolError(status === 401 || status === 403 ? status : 409,
        status === 401 || status === 403 ? "unauthorized" : "invalid-response-envelope");
      if (response.headers["content-encoding"] || response.headers["content-type"] !== "application/json") {
        throw invalidEnvelope();
      }

      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for await (const chunk of response) {
          const owned = this.responseChunk(chunk);
          length += owned.length;
          if (length > 1024) {
            throw invalidEnvelope();
          }

          chunks.push(owned);
        }
      } catch (error) {
        if (error instanceof SyncProtocolError) {
          throw error;
        }

        throw new SyncProtocolError(503, "response-truncated");
      }

      if (!response.complete) {
        throw new SyncProtocolError(503, "response-truncated");
      }

      let failure: SyncProtocolError;
      try {
        failure = parseRemoteFailure(decodeJson(Buffer.concat(chunks, length)), status);
      } catch {
        // Only a completely received, bounded envelope can provide a remote hint.
        throw invalidEnvelope();
      }

      throw failure;
    }

    if (response.headers["content-encoding"] || response.headers["content-type"] !== contentType) {
      throw new SyncProtocolError(409, "invalid-response-envelope");
    }
  }

  private responseChunk(chunk: unknown): Buffer {
    if (!(chunk instanceof Uint8Array)) {
      throw new SyncProtocolError(409, "invalid-response-bytes");
    }

    const owned = Buffer.from(chunk);
    this.counters.responseBytes += owned.length;
    return owned;
  }
}
