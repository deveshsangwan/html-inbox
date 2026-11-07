import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hardenPrivateDirectory, hardenPrivateFile } from "./private-storage";
import { temporaryHome } from "./test-fixtures";

// Characterize path-based chmod at a controlled lstat-to-chmod interleaving.
// A descriptor-based design would need an explicitly reviewed contract change.
for (const kind of ["file", "directory"] as const) {
  const privateMode = kind === "file" ? 0o600 : 0o700;
  const harden = kind === "file" ? hardenPrivateFile : hardenPrivateDirectory;

  test(`private ${kind} removed after inspection still reports ENOENT`, async (t) => {
    const home = await temporaryHome(t);
    const target = path.join(home, "target");

    if (kind === "file") {
      await fs.writeFile(target, "fixture", { mode: privateMode });
    } else {
      await fs.mkdir(target, { mode: privateMode });
    }

    const lstat = fs.lstat;
    let interceptions = 0;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const checked = await lstat(...args);

      if (String(args[0]) === target) {
        interceptions += 1;
        await fs.rm(target, { recursive: true });
      }

      return checked;
    });

    await assert.rejects(harden(target), { code: "ENOENT" });
    assert.equal(interceptions, 1);
  });

  test(`private ${kind} replaced after inspection still repairs the replacement`, {
    skip: process.platform === "win32" ? "POSIX mode repair contract" : false,
  }, async (t) => {
    const home = await temporaryHome(t);
    const target = path.join(home, "target");

    if (kind === "file") {
      await fs.writeFile(target, "fixture", { mode: privateMode });
    } else {
      await fs.mkdir(target, { mode: privateMode });
    }

    const lstat = fs.lstat;
    let interceptions = 0;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      const checked = await lstat(...args);

      if (String(args[0]) === target) {
        interceptions += 1;
        await fs.rm(target, { recursive: true });

        if (kind === "file") {
          await fs.writeFile(target, "replacement");
        } else {
          await fs.mkdir(target);
        }

        await fs.chmod(target, 0o777);
      }

      return checked;
    });

    await harden(target);

    assert.equal(interceptions, 1);
    assert.equal((await fs.stat(target)).mode & 0o7777, privateMode);
  });
}
