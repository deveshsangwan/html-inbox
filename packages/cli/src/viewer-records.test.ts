import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { temporaryHome } from "./test-fixtures";
import {
  readSavedViewerConfiguration,
  readViewerRecord,
  writeViewerRecord,
  type ViewerRecord,
} from "./viewer-records";
import { VIEWER_PROTOCOL_VERSION } from "./viewer-status";
import { ManagedStorageError } from "./private-storage";

const recordRaceSkip =
  process.platform === "win32"
    ? "Descriptor and symlink permission-race checks require POSIX no-follow support."
    : false;
const configuration = {
  version: 1,
  config: { port: 3217, exposure: "loopback", host: "127.0.0.1" },
  urls: ["http://127.0.0.1:3217"],
};

test(
  "saved viewer reads never chmod a filename checked before opening",
  { skip: recordRaceSkip },
  async (t) => {
    const home = await temporaryHome(t);
    const recordPath = path.join(home, "viewer-config.json");
    const targetPath = path.join(home, "unrelated-file");
    await fsPromises.writeFile(recordPath, JSON.stringify(configuration), {
      mode: 0o644,
    });
    await fsPromises.writeFile(targetPath, "untouched", { mode: 0o640 });
    const originalLstat = fsPromises.lstat;
    let replacedCheckedFilename = false;
    t.mock.method(
      fsPromises,
      "lstat",
      async (filePath: Parameters<typeof originalLstat>[0]) => {
        const info = await originalLstat(filePath);
        if (filePath === recordPath && !replacedCheckedFilename) {
          replacedCheckedFilename = true;
          await fsPromises.rename(recordPath, `${recordPath}.original`);
          await fsPromises.symlink(targetPath, recordPath);
        }

        return info;
      },
    );

    const [outcome] = await Promise.allSettled([
      readSavedViewerConfiguration(home),
    ]);
    assert.equal((await originalLstat(targetPath)).mode & 0o777, 0o640);
    assert.equal(replacedCheckedFilename, false);
    assert.equal(outcome.status, "fulfilled");
    assert.equal(await fsPromises.readFile(targetPath, "utf8"), "untouched");
  },
);

test(
  "saved viewer reads harden only the opened descriptor after its filename is replaced",
  { skip: recordRaceSkip },
  async (t) => {
    const home = await temporaryHome(t);
    const recordPath = path.join(home, "viewer-config.json");
    const originalPath = `${recordPath}.original`;
    const targetPath = path.join(home, "unrelated-file");
    await fsPromises.writeFile(recordPath, JSON.stringify(configuration), {
      mode: 0o644,
    });
    await fsPromises.writeFile(targetPath, "untouched", { mode: 0o640 });
    const originalOpen = fsPromises.open;
    let replacedOpenedFilename = false;
    t.mock.method(
      fsPromises,
      "open",
      async (
        filePath: Parameters<typeof originalOpen>[0],
        flags: Parameters<typeof originalOpen>[1],
        mode?: Parameters<typeof originalOpen>[2],
      ) => {
        const file = await originalOpen(filePath, flags, mode);
        if (filePath === recordPath && !replacedOpenedFilename) {
          replacedOpenedFilename = true;
          await fsPromises.rename(recordPath, originalPath);
          await fsPromises.symlink(targetPath, recordPath);
        }

        return file;
      },
    );

    assert.deepEqual(await readSavedViewerConfiguration(home), {
      config: configuration.config,
      urls: configuration.urls,
      tailscaleExecutable: undefined,
    });
    assert.equal(replacedOpenedFilename, true);
    assert.equal((await fsPromises.lstat(originalPath)).mode & 0o777, 0o600);
    assert.equal((await fsPromises.lstat(targetPath)).mode & 0o777, 0o640);
    assert.equal(await fsPromises.readFile(targetPath, "utf8"), "untouched");
    await assert.rejects(
      readSavedViewerConfiguration(home),
      (error: unknown) =>
        error instanceof ManagedStorageError &&
        /Managed file is not a regular file/.test(error.message),
    );
  },
);

test(
  "saved viewer reads reject hardlinked records before changing either link's permissions",
  { skip: recordRaceSkip },
  async (t) => {
    const home = await temporaryHome(t);
    const targetPath = path.join(home, "unrelated-file");
    await fsPromises.writeFile(targetPath, JSON.stringify(configuration), {
      mode: 0o640,
    });
    await fsPromises.link(targetPath, path.join(home, "viewer-config.json"));

    await assert.rejects(
      readSavedViewerConfiguration(home),
      /regular private file/,
    );
    assert.equal((await fsPromises.lstat(targetPath)).mode & 0o777, 0o640);
  },
);

test(
  "administrator saved-config reads never change the opened record's permissions",
  { skip: recordRaceSkip },
  async (t) => {
    const home = await temporaryHome(t);
    const recordPath = path.join(home, "viewer-config.json");
    await fsPromises.writeFile(recordPath, JSON.stringify(configuration), {
      mode: 0o640,
    });
    const getUid = process.getuid;
    process.getuid = () => 0;
    t.after(() => {
      process.getuid = getUid;
    });

    assert.deepEqual(
      (await readSavedViewerConfiguration(home))?.config,
      configuration.config,
    );
    assert.equal((await fsPromises.lstat(recordPath)).mode & 0o777, 0o640);
  },
);

test("an opened viewer record unlinked by shutdown is reread before being treated as missing", async (t) => {
  const home = await temporaryHome(t);
  const recordPath = path.join(home, "viewer-config.json");
  await fsPromises.writeFile(recordPath, JSON.stringify(configuration));
  const originalOpen = fsPromises.open;
  let removedOpenedRecord = false;
  t.mock.method(
    fsPromises,
    "open",
    async (
      filePath: Parameters<typeof originalOpen>[0],
      flags: Parameters<typeof originalOpen>[1],
      mode?: Parameters<typeof originalOpen>[2],
    ) => {
      const file = await originalOpen(filePath, flags, mode);
      if (filePath === recordPath && !removedOpenedRecord) {
        removedOpenedRecord = true;
        await fsPromises.rm(recordPath);
      }

      return file;
    },
  );

  assert.equal(await readSavedViewerConfiguration(home), null);
  assert.equal(removedOpenedRecord, true);
});

test("an atomically replaced viewer record is reread so shutdown failures remain observable", async (t) => {
  const home = await temporaryHome(t);
  const recordPath = path.join(home, "viewer.json");
  const record: ViewerRecord = {
    pid: process.pid,
    instanceId: randomUUID(),
    processId: randomUUID(),
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    config: { port: 3217, exposure: "loopback", host: "127.0.0.1" },
    urls: ["http://127.0.0.1:3217"],
    controlUrl: `http://127.0.0.1:3218/control/${"A".repeat(43)}`,
    startedAt: new Date().toISOString(),
  };
  await writeViewerRecord(home, record);
  const originalOpen = fsPromises.open;
  let replacedOpenedRecord = false;
  t.mock.method(
    fsPromises,
    "open",
    async (
      filePath: Parameters<typeof originalOpen>[0],
      flags: Parameters<typeof originalOpen>[1],
      mode?: Parameters<typeof originalOpen>[2],
    ) => {
      const file = await originalOpen(filePath, flags, mode);
      if (filePath === recordPath && !replacedOpenedRecord) {
        replacedOpenedRecord = true;
        await writeViewerRecord(home, {
          ...record,
          shutdownError: "Recorded cleanup failed",
        });
      }

      return file;
    },
  );

  assert.equal(
    (await readViewerRecord(home))?.shutdownError,
    "Recorded cleanup failed",
  );
  assert.equal(replacedOpenedRecord, true);
});

test("repeated record replacement fails with a bounded actionable retry", async (t) => {
  const home = await temporaryHome(t);
  const recordPath = path.join(home, "viewer-config.json");
  await fsPromises.writeFile(recordPath, JSON.stringify(configuration));
  const originalOpen = fsPromises.open;
  let replacements = 0;
  t.mock.method(
    fsPromises,
    "open",
    async (
      filePath: Parameters<typeof originalOpen>[0],
      flags: Parameters<typeof originalOpen>[1],
      mode?: Parameters<typeof originalOpen>[2],
    ) => {
      const file = await originalOpen(filePath, flags, mode);
      if (filePath === recordPath) {
        replacements += 1;
        await fsPromises.rm(recordPath);
        await fsPromises.writeFile(recordPath, JSON.stringify(configuration));
      }

      return file;
    },
  );

  await assert.rejects(
    readSavedViewerConfiguration(home),
    /changed repeatedly.*retry/,
  );
  assert(replacements > 1 && replacements < 10);
});

test(
  "the missing-no-follow fallback refuses a symlink substituted between lstat and open",
  { skip: recordRaceSkip },
  async (t) => {
    const home = await temporaryHome(t);
    const recordPath = path.join(home, "viewer-config.json");
    const targetPath = path.join(home, "unrelated-file");
    await fsPromises.writeFile(recordPath, JSON.stringify(configuration), {
      mode: 0o640,
    });
    await fsPromises.writeFile(targetPath, JSON.stringify(configuration), {
      mode: 0o640,
    });
    const { readConfiguration } = await fallbackRecordReaders();
    const originalOpen = fsPromises.open;
    let replacedCheckedFilename = false;
    t.mock.method(
      fsPromises,
      "open",
      async (
        filePath: Parameters<typeof originalOpen>[0],
        flags: Parameters<typeof originalOpen>[1],
        mode?: Parameters<typeof originalOpen>[2],
      ) => {
        if (filePath === recordPath && !replacedCheckedFilename) {
          replacedCheckedFilename = true;
          await fsPromises.rename(recordPath, `${recordPath}.original`);
          await fsPromises.symlink(targetPath, recordPath);
        }

        return originalOpen(filePath, flags, mode);
      },
    );

    await assert.rejects(readConfiguration(home), /regular private file/);
    assert.equal(replacedCheckedFilename, true);
    assert.equal((await fsPromises.lstat(targetPath)).mode & 0o777, 0o640);
  },
);

test("the missing-no-follow fallback rereads a record removed after its descriptor stat", async (t) => {
  const home = await temporaryHome(t);
  const recordPath = path.join(home, "viewer-config.json");
  await fsPromises.writeFile(recordPath, JSON.stringify(configuration));
  const { readConfiguration } = await fallbackRecordReaders();
  const originalOpen = fsPromises.open;
  let removedAfterStat = false;
  t.mock.method(
    fsPromises,
    "open",
    async (
      filePath: Parameters<typeof originalOpen>[0],
      flags: Parameters<typeof originalOpen>[1],
      mode?: Parameters<typeof originalOpen>[2],
    ) => {
      const file = await originalOpen(filePath, flags, mode);
      if (filePath === recordPath && !removedAfterStat) {
        const originalStat = file.stat.bind(file);
        t.mock.method(file, "stat", async () => {
          const info = await originalStat();
          if (!removedAfterStat) {
            removedAfterStat = true;
            await fsPromises.rm(recordPath);
          }

          return info;
        });
      }

      return file;
    },
  );

  assert.equal(await readConfiguration(home), null);
  assert.equal(removedAfterStat, true);
});

test("the missing-no-follow fallback rereads a replacement shutdown failure marker", async (t) => {
  const home = await temporaryHome(t);
  const recordPath = path.join(home, "viewer.json");
  const record: ViewerRecord = {
    pid: process.pid,
    instanceId: randomUUID(),
    processId: randomUUID(),
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    config: { port: 3217, exposure: "loopback", host: "127.0.0.1" },
    urls: ["http://127.0.0.1:3217"],
    controlUrl: `http://127.0.0.1:3218/control/${"A".repeat(43)}`,
    startedAt: new Date().toISOString(),
  };
  await writeViewerRecord(home, record);
  const { readRecord } = await fallbackRecordReaders();
  const originalOpen = fsPromises.open;
  let replacedAfterStat = false;
  t.mock.method(
    fsPromises,
    "open",
    async (
      filePath: Parameters<typeof originalOpen>[0],
      flags: Parameters<typeof originalOpen>[1],
      mode?: Parameters<typeof originalOpen>[2],
    ) => {
      const file = await originalOpen(filePath, flags, mode);
      if (filePath === recordPath && !replacedAfterStat) {
        const originalStat = file.stat.bind(file);
        t.mock.method(file, "stat", async () => {
          const info = await originalStat();
          if (!replacedAfterStat) {
            replacedAfterStat = true;
            await writeViewerRecord(home, {
              ...record,
              shutdownError: "Recorded cleanup failed",
            });
          }

          return info;
        });
      }

      return file;
    },
  );

  const value = await readRecord(home);
  assert(
    typeof value === "object" && value !== null && "shutdownError" in value,
  );
  assert.equal(value.shutdownError, "Recorded cleanup failed");
  assert.equal(replacedAfterStat, true);
});

async function fallbackRecordReaders() {
  const modulePath = path.join(__dirname, "viewer-records.js");
  const requireModule = createRequire(modulePath);
  const recordExports: Record<string, unknown> = {};
  vm.runInNewContext(await fsPromises.readFile(modulePath, "utf8"), {
    exports: recordExports,
    require: (specifier: string): unknown =>
      specifier === "node:fs"
        ? { constants: { ...constants, O_NOFOLLOW: 0 } }
        : requireModule(specifier),
    Buffer,
    Error,
    URL,
    process,
  });
  const readConfiguration = recordExports.readSavedViewerConfiguration;
  const readRecord = recordExports.readViewerRecord;
  assert(
    typeof readConfiguration === "function" && typeof readRecord === "function",
  );

  return {
    readConfiguration: async (home: string): Promise<unknown> =>
      readConfiguration(home),
    readRecord: async (home: string): Promise<unknown> => readRecord(home),
  };
}
