import { constants } from "node:fs";
import { lstat, open, readdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedFile } from "./bounded-file";
import { canonicalizeInboxHome, InboxInspectionError, inspectInboxHome, readInboxIdentity } from "./inbox-home";
import { ensurePrivateDirectory, hardenPrivateDirectory, ManagedStorageError, PRIVATE_FILE_MODE, writeAtomicPrivateJson } from "./private-storage";
import { assertUuidV4, isRecord } from "./validation";
import { getInboxInstanceId, hasErrorCode } from "./viewer-records";

export { InboxInspectionError, type InboxInspectionState } from "./inbox-home";

export interface NamedInbox {
  name: string;
  home: string;
  instanceId: string;
}

export interface InboxCatalog {
  inboxes: NamedInbox[];
  defaultName?: string;
}

export function getInboxCatalogHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HTML_INBOX_CATALOG_HOME ?? path.join(homedir(), ".config", "html-inbox");
  if (!home || !path.isAbsolute(home) || home.includes("\0")) {
    throw new Error("HTML_INBOX_CATALOG_HOME must be an absolute path");
  }

  return path.resolve(home);
}

export function assertInboxName(name: string): void {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)) {
    throw new Error("Inbox name must use 1-63 lowercase letters, digits, underscores, or hyphens and cannot be a reserved filename");
  }
}

export async function readInboxCatalog(
  catalogHome = getInboxCatalogHome(),
  options: { includeDefault?: boolean; readOnly?: boolean } = {},
): Promise<InboxCatalog> {
  const root = checkedCatalogHome(catalogHome);
  if (!await hasCatalogDirectory(root, options.readOnly)) {
    return { inboxes: [] };
  }

  const entriesHome = path.join(root, "inboxes");
  const names = await hasCatalogDirectory(entriesHome, options.readOnly) ? await readdir(entriesHome) : [];
  const inboxes: NamedInbox[] = [];
  for (const fileName of names.filter((name) => name.endsWith(".json")).sort()) {
    const name = fileName.slice(0, -5);
    const entry = await readNamedInboxEntry(name, root, options.readOnly);
    if (entry) {
      assertUniqueInbox(inboxes, entry);
      inboxes.push(entry);
    }
  }

  const defaultName = options.includeDefault === false ? undefined : await readDefaultInbox(root, options.readOnly);
  return { inboxes, ...(defaultName ? { defaultName } : {}) };
}

export async function readNamedInbox(name: string, catalogHome = getInboxCatalogHome()): Promise<NamedInbox | null> {
  return readNamedInboxEntry(name, checkedCatalogHome(catalogHome));
}

async function readNamedInboxEntry(name: string, root: string, readOnly = false): Promise<NamedInbox | null> {
  assertInboxName(name);
  if (!await hasCatalogDirectory(root, readOnly) || !await hasCatalogDirectory(path.join(root, "inboxes"), readOnly)) {
    return null;
  }

  const record = await readCatalogJson(path.join(root, "inboxes", `${name}.json`), readOnly);
  if (record === null) {
    return null;
  }

  const entry = parseNamedInbox(record.value);
  if (entry.name !== name) {
    throw new Error(`Catalog entry name does not match its filename: ${name}`);
  }

  return entry;
}

export async function inspectRegisteredInbox(entry: NamedInbox): Promise<NamedInbox> {
  const expected = parseNamedInbox({ schemaVersion: 1, ...entry });
  try {
    const home = await canonicalizeInboxHome(expected.home);
    if (home !== expected.home) {
      throw new InboxInspectionError("conflict", `Registered inbox ${expected.name} has a different canonical location`);
    }

    if (await readInboxIdentity(home) !== expected.instanceId) {
      throw new InboxInspectionError("conflict", `Registered inbox ${expected.name} has a missing or different identity`);
    }

    await inspectInboxHome(home);
    return expected;
  } catch (error) {
    if (error instanceof InboxInspectionError) {
      throw error;
    }

    const state = hasErrorCode(error, "ENOENT") ? "missing" : "incompatible";
    throw new InboxInspectionError(state, `Cannot inspect registered inbox ${expected.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function registerInbox(name: string, home: string, catalogHome = getInboxCatalogHome()): Promise<NamedInbox> {
  assertInboxName(name);
  const inspected = await inspectInboxHome(home);

  return withCatalogRegistration(catalogHome, async (root) => {
    const catalog = await readInboxCatalog(root);
    assertAvailableInbox(catalog.inboxes, name, inspected.home);

    const instanceId = inspected.instanceId ?? (await getInboxInstanceId(inspected.home)).toLowerCase();
    const entry = { name, home: inspected.home, instanceId };
    assertUniqueInbox(catalog.inboxes, entry);
    await inspectRegisteredInbox(entry);
    await publishCatalogEntry(root, entry);

    return entry;
  });
}

export async function createInbox(name: string, home: string, catalogHome = getInboxCatalogHome()): Promise<NamedInbox> {
  assertInboxName(name);
  const canonicalHome = await canonicalizeInboxHome(home, true);

  return withCatalogRegistration(catalogHome, async (root) => {
    const catalog = await readInboxCatalog(root);
    assertAvailableInbox(catalog.inboxes, name, canonicalHome);

    const contents = await readdir(canonicalHome).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return [];
      }

      throw error;
    });
    if (contents.length > 0) {
      throw new Error(`Cannot create inbox in a nonempty home; register an existing library instead: ${canonicalHome}`);
    }

    await ensurePrivateDirectory(canonicalHome);
    await ensurePrivateDirectory(path.join(canonicalHome, "documents"));
    const entry = { name, home: canonicalHome, instanceId: (await getInboxInstanceId(canonicalHome)).toLowerCase() };
    assertUniqueInbox(catalog.inboxes, entry);
    await publishCatalogEntry(root, entry);

    return entry;
  });
}

export async function setDefaultInbox(name: string, catalogHome = getInboxCatalogHome()): Promise<void> {
  const entry = await readNamedInbox(name, catalogHome);
  if (!entry) {
    throw new Error(`Unknown inbox: ${name}`);
  }

  await inspectRegisteredInbox(entry);
  const defaultPath = path.join(checkedCatalogHome(catalogHome), "default.json");
  const existing = await lstat(defaultPath).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  });

  // The atomic writer hardens an existing file before replacement, so reject shared inodes first.
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error(`Catalog record must be a regular private file: ${defaultPath}`);
  }

  await writeAtomicPrivateJson(defaultPath, { schemaVersion: 1, name });
}

export async function clearDefaultInbox(catalogHome = getInboxCatalogHome()): Promise<void> {
  const root = checkedCatalogHome(catalogHome);
  if (!await hasCatalogDirectory(root)) {
    return;
  }

  try {
    await unlink(path.join(root, "default.json"));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function checkedCatalogHome(home: string): string {
  return getInboxCatalogHome({ HTML_INBOX_CATALOG_HOME: home });
}

function parseNamedInbox(value: unknown): NamedInbox {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== "string" ||
      typeof value.home !== "string" || !path.isAbsolute(value.home) || value.home.includes("\0") ||
      path.resolve(value.home) !== value.home || typeof value.instanceId !== "string") {
    throw new Error("Inbox catalog entry must use schema version 1 with a name, canonical absolute home, and UUID identity");
  }

  assertInboxName(value.name);
  assertUuidV4(value.instanceId, "Catalog inbox identity");
  return { name: value.name, home: value.home, instanceId: value.instanceId.toLowerCase() };
}

function assertAvailableInbox(inboxes: NamedInbox[], name: string, home: string): void {
  if (inboxes.some((entry) => entry.name === name)) {
    throw new Error(`Inbox name is already registered: ${name}`);
  }

  const existing = inboxes.find((entry) => entry.home === home);
  if (existing) {
    throw new InboxInspectionError("conflict", `Inbox location is already registered as ${existing.name}: ${home}`);
  }
}

function assertUniqueInbox(inboxes: NamedInbox[], entry: NamedInbox): void {
  assertAvailableInbox(inboxes, entry.name, entry.home);
  const existing = inboxes.find((other) => other.instanceId === entry.instanceId);
  if (existing) {
    throw new InboxInspectionError("conflict", `Inbox identity is already registered at ${existing.home}; copied libraries cannot be registered: ${entry.home}`);
  }
}

async function hasCatalogDirectory(home: string, readOnly = false): Promise<boolean> {
  try {
    if (readOnly) {
      const info = await lstat(home);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ManagedStorageError(`Managed directory is not a regular directory: ${home}`);
      }
    } else {
      await hardenPrivateDirectory(home);
    }

    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

async function readDefaultInbox(root: string, readOnly = false): Promise<string | undefined> {
  const record = await readCatalogJson(path.join(root, "default.json"), readOnly);
  if (record === null) {
    return undefined;
  }

  const value = record.value;
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.name !== "string") {
    throw new Error("Inbox default must use schema version 1 with a registered name");
  }

  assertInboxName(value.name);
  return value.name;
}

async function readCatalogJson(filePath: string, readOnly = false): Promise<{ value: unknown } | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const checked = await lstat(filePath).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return null;
      }

      throw error;
    });
    if (!checked) {
      return null;
    }

    if (!checked.isFile() || checked.isSymbolicLink() || checked.nlink !== 1) {
      throw new Error(`Catalog record must be a regular private file: ${filePath}`);
    }

    const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      .catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) {
          return null;
        }

        throw error;
      });
    if (!file) {
      continue;
    }

    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink > 1) {
        throw new Error(`Catalog record must be a regular private file: ${filePath}`);
      }

      if (info.nlink === 0 || info.dev !== checked.dev || info.ino !== checked.ino) {
        continue;
      }

      if (!readOnly) {
        await file.chmod(PRIVATE_FILE_MODE);
      }

      const bytes = await readBoundedFile(file, 64 * 1024, `Catalog record is too large: ${filePath}`);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      return { value };
    } finally {
      await file.close();
    }
  }

  throw new Error(`Catalog record changed repeatedly during read; retry the command: ${filePath}`);
}

async function withCatalogRegistration<T>(catalogHome: string, register: (root: string) => Promise<T>): Promise<T> {
  const root = checkedCatalogHome(catalogHome);
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(path.join(root, "inboxes"));
  const lockPath = path.join(root, "registration.lock");
  const deadline = Date.now() + 10_000;

  while (true) {
    const lock = await open(lockPath, "wx", PRIVATE_FILE_MODE).catch((error: unknown) => {
      if (hasErrorCode(error, "EEXIST")) {
        return null;
      }

      // Windows can deny creation while the previous lock is pending deletion.
      if (process.platform === "win32" && hasErrorCode(error, "EPERM") && Date.now() < deadline) {
        return null;
      }

      throw error;
    });
    if (lock) {
      try {
        await lock.writeFile(`${process.pid}\n`);
        return await register(root);
      } finally {
        await lock.close();
        await rm(lockPath);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`Catalog registration is busy or was interrupted; stop registration commands before removing ${lockPath}`);
    }

    await delay(10);
  }
}

async function publishCatalogEntry(root: string, entry: NamedInbox): Promise<void> {
  // The registration lock protects the absent name and location/identity checks until publication.
  const filePath = path.join(root, "inboxes", `${entry.name}.json`);
  await writeAtomicPrivateJson(filePath, { schemaVersion: 1, ...entry });
}
