import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { readBoundedFile } from "./bounded-file";
import { parseLocalDocumentLocation, type LocalDocumentLocation } from "./local-document-source";
import { isRecord } from "./validation";

export interface HubSourceConfig extends LocalDocumentLocation {
  name: string;
}

export interface HubConfiguration {
  schemaVersion: 1;
  name: string;
  sources: HubSourceConfig[];
}

export function parseHubConfig(value: unknown): HubConfiguration {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== "string" ||
      !Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 128 ||
      Object.keys(value).some((key) => !["schemaVersion", "name", "sources"].includes(key))) {
    throw new Error("Hub config must use schema version 1 and contain 1-128 explicit sources");
  }

  if (!value.name.trim() || value.name.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value.name)) {
    throw new Error("Hub name must contain 1-200 characters without control characters");
  }

  const names = new Set<string>();
  const homes = new Set<string>();
  const identities = new Set<string>();
  const sources = value.sources.map((source) => {
    if (!isRecord(source) || typeof source.name !== "string" || typeof source.home !== "string" ||
        typeof source.instanceId !== "string" ||
        Object.keys(source).some((key) => !["name", "home", "instanceId"].includes(key))) {
      throw new Error("Hub source must contain only name, home, and instanceId");
    }

    assertName(source.name);
    const location = parseLocalDocumentLocation({ home: source.home, instanceId: source.instanceId });
    if (names.has(source.name) || homes.has(location.home) || identities.has(location.instanceId.toLowerCase())) {
      throw new Error("Hub source names, homes, and instance identities must be unique");
    }

    names.add(source.name);
    homes.add(location.home);
    identities.add(location.instanceId.toLowerCase());
    return { name: source.name, ...location };
  });

  return { schemaVersion: 1, name: value.name, sources };
}

export async function readHubConfig(filePath: string): Promise<HubConfiguration> {
  await checkConfigParent(filePath);
  const checked = await lstat(filePath);
  // A crash after exclusive publication can leave the complete temporary hard link.
  if (!checked.isFile() || checked.isSymbolicLink()) {
    throw new Error("Hub config must be a regular file");
  }

  const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== checked.dev || info.ino !== checked.ino) {
      throw new Error("Hub config changed during read");
    }

    const bytes = await readBoundedFile(file, 1024 * 1024, "Hub config exceeds its byte limit");
    return parseHubConfig(JSON.parse(bytes.toString("utf8")));
  } finally {
    await file.close();
  }
}

export async function writeHubConfig(filePath: string, config: HubConfiguration): Promise<HubConfiguration> {
  const parsed = parseHubConfig(config);
  await checkConfigParent(filePath);
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomUUID()}`);
  const file = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }

    await link(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  return parsed;
}

async function checkConfigParent(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath || await realpath(parent) !== parent) {
    throw new Error("Hub config path must have an existing canonical parent");
  }
}

function assertName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name)) {
    throw new Error("Source names must use 1-63 lowercase letters, digits, underscores, or hyphens and avoid reserved file names");
  }
}
