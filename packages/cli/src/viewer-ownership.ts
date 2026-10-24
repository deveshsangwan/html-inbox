import { realpath, stat } from "node:fs/promises";
import { readInboxIdentity } from "./inbox-home";
import { isDeadOwner, processStart } from "./sync-files";
import { assertExactKeys, parseInteger, parseObject, parseString } from "./sync-model";
import type { ViewerRecord } from "./viewer-records";

export interface ViewerLocalOwner {
  home: string;
  dev: number;
  ino: number;
  start: string | null;
}

export function parseViewerLocalOwner(value: unknown): ViewerLocalOwner {
  const owner = parseObject(value, "viewer local ownership");
  assertExactKeys(owner, ["home", "dev", "ino", "start"]);
  return { home: parseString(owner.home), dev: parseInteger(owner.dev), ino: parseInteger(owner.ino), start: owner.start === null ? null : parseString(owner.start) };
}

export async function currentViewerLocalOwner(home: string): Promise<ViewerLocalOwner> {
  const info = await stat(home);
  return { home: await realpath(home), dev: info.dev, ino: info.ino, start: await processStart(process.pid) };
}

export async function verifyViewerLocalOwner(home: string, record: ViewerRecord): Promise<"live" | "dead"> {
  const owner = record.localOwner;
  const current = await currentViewerLocalOwner(home);
  if (!owner || owner.home !== home || current.home !== home || owner.dev !== current.dev || owner.ino !== current.ino ||
      await readInboxIdentity(home) !== record.instanceId.toLowerCase()) {
    throw new Error("Viewer ownership is copied, old or locally ambiguous; no endpoint was contacted");
  }

  if (await isDeadOwner({ token: record.processId, pid: record.pid, start: owner.start })) {
    return "dead";
  }

  if (owner.start !== null && await processStart(record.pid) !== owner.start) {
    throw new Error("Viewer process ownership cannot be established locally");
  }

  return "live";
}
