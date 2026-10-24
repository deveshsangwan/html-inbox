import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { readBoundedFile } from "./bounded-file";
import { SYNC_LIMITS } from "./sync-model";

function isPrivateLedgerFile(info: BigIntStats): boolean {
  return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077n) === 0n &&
    info.size >= 0n && info.size <= BigInt(SYNC_LIMITS.ledgerBytes) && (!process.getuid || info.uid === BigInt(process.getuid()));
}

function isSameInode(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function hasSameMetadata(first: BigIntStats, second: BigIntStats): boolean {
  return isSameInode(first, second) && first.mode === second.mode && first.uid === second.uid && first.size === second.size;
}

async function hasSafeReplacement(ledgerPath: string, stale: BigIntStats): Promise<boolean> {
  const current = await lstat(ledgerPath, { bigint: true });
  return isPrivateLedgerFile(current) && current.nlink === 1n && current.dev === stale.dev && current.ino !== stale.ino;
}

async function matchesCanonicalLedger(ledgerPath: string, opened: BigIntStats): Promise<boolean> {
  const current = await lstat(ledgerPath, { bigint: true });
  return isPrivateLedgerFile(current) && current.nlink === 1n && hasSameMetadata(current, opened);
}

/** Only immutable ledger replacement supplies retry evidence. Unsafe files supply no bytes. */
export async function readManagedLedgerBytes(ledgerPath: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const checked = await lstat(ledgerPath, { bigint: true });
    if (!isPrivateLedgerFile(checked)) {
      throw new Error("Managed ledger must be a bounded private regular file owned by the current account");
    }

    if (checked.nlink === 0n && await hasSafeReplacement(ledgerPath, checked)) {
      continue;
    }

    if (checked.nlink !== 1n) {
      throw new Error("Managed ledger must have exactly one link");
    }

    const file = await open(ledgerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await file.stat({ bigint: true });
      if (!isPrivateLedgerFile(opened)) {
        throw new Error("Managed ledger became unsafe during open");
      }

      if (!isSameInode(checked, opened)) {
        if (opened.nlink === 1n && checked.dev === opened.dev && await matchesCanonicalLedger(ledgerPath, opened)) {
          continue;
        }

        throw new Error("Managed ledger changed without a safe replacement during open");
      }

      if (!hasSameMetadata(checked, opened)) {
        throw new Error("Managed ledger metadata changed during open");
      }

      if (opened.nlink === 0n && await hasSafeReplacement(ledgerPath, opened)) {
        continue;
      }

      if (opened.nlink !== 1n) {
        throw new Error("Managed ledger became unsafe during open");
      }

      const bytes = await readBoundedFile(file, SYNC_LIMITS.ledgerBytes, "Managed ledger exceeds byte limit");
      const completed = await file.stat({ bigint: true });
      if (!isPrivateLedgerFile(completed) || !hasSameMetadata(opened, completed)) {
        throw new Error("Managed ledger metadata changed during read");
      }

      if (completed.nlink === 0n && await hasSafeReplacement(ledgerPath, completed)) {
        continue;
      }

      if (completed.nlink !== 1n) {
        throw new Error("Managed ledger became unsafe during read");
      }

      return bytes;
    } finally {
      await file.close();
    }
  }

  throw new Error("Unable to obtain a coherent ledger snapshot after four replacements");
}
