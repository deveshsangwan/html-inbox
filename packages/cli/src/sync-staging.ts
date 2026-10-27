import { randomUUID } from "node:crypto";
import { open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DurableFiles, isDeadOwner, optionalStat, processStart, readPrivateFile } from "./sync-files";
import { assertExactKeys, parseInteger, parseObject, parseString } from "./sync-model";

const MAX_RESERVATIONS = 16;
const MAX_STAGED_BYTES = 64 * 1024 * 1024;

/** Reservations are created, reclaimed and released only while the inbox mutation lock is held. */
export class SyncStaging {
  constructor(private readonly directory: string, private readonly files: DurableFiles) {}

  async reserve(byteLength: number): Promise<string> {
    parseInteger(byteLength, 0, 10 * 1024 * 1024);
    await this.cleanDead();
    const entries = await readdir(this.directory);
    let reservations = 0;
    let bytes = 0;
    for (const name of entries) {
      if (name.endsWith(".stage.lease")) {
        const lease = await this.readLease(path.join(this.directory, name));
        reservations += 1;
        bytes += lease.byteLength;
      } else if (!name.endsWith(".stage") || !entries.includes(`${name}.lease`)) {
        throw new Error("Unknown staging ownership blocks new reservations");
      }
    }

    if (reservations >= MAX_RESERVATIONS || bytes + byteLength > MAX_STAGED_BYTES) {
      throw new Error("Sync staging quota exceeded");
    }

    const staged = path.join(this.directory, `${randomUUID()}.stage`);
    const lease = { token: randomUUID(), pid: process.pid, start: await processStart(process.pid), byteLength };
    await this.files.exclusiveFile(`${staged}.lease`, JSON.stringify(lease));
    try {
      const file = await open(staged, "wx", 0o600);
      await file.close();
      await this.files.flushDirectory(this.directory);
      return staged;
    } catch (error) {
      await this.release(staged);
      throw error;
    }
  }

  async release(staged: string): Promise<void> {
    // Installation may have moved the stage. Never infer a final-body path or delete final bodies here.
    await rm(staged, { force: true });
    await rm(`${staged}.lease`, { force: true });
    await this.files.flushDirectory(this.directory);
  }

  async cleanDead(): Promise<void> {
    const entries = await readdir(this.directory);
    for (const name of entries.filter((name) => /^[a-f0-9-]{36}\.stage\.lease$/.test(name))) {
      const leasePath = path.join(this.directory, name);
      const lease = await this.readLease(leasePath);
      if (!await isDeadOwner(lease)) {
        continue;
      }

      const checked = await this.readLease(leasePath);
      if (checked.token === lease.token && checked.pid === lease.pid && checked.start === lease.start) {
        await this.release(leasePath.slice(0, -6));
      }
    }
  }

  private async readLease(filename: string) {
    const record = parseObject(JSON.parse((await readPrivateFile(filename, 4096)).toString("utf8")), "stage lease");
    assertExactKeys(record, ["token", "pid", "start", "byteLength"]);
    const staged = filename.slice(0, -6);
    const info = await optionalStat(staged);
    const byteLength = parseInteger(record.byteLength, 0, 10 * 1024 * 1024);
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > byteLength)) {
      throw new Error("Invalid reserved stage file");
    }

    return { token: parseString(record.token), pid: parseInteger(record.pid, 1), start: record.start === null ? null : parseString(record.start), byteLength };
  }
}
