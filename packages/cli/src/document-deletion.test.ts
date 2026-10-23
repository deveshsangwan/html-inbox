import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalDocumentBackend } from "./backend";
import { createDocumentDeleter, DocumentCleanupError, DocumentIdentityError } from "./document-deletion";
import { LocalDocumentSource } from "./local-document-source";
import { temporaryHome } from "./test-fixtures";
import { getInboxInstanceId } from "./viewer-records";

const posixOnly = { skip: process.platform === "win32" };

test("deletion removes actual files permanently and preserves the CLI result schema", async (t) => {
  const fixture = await deletionFixture(t);
  const retained = await fixture.backend.publish({ ...fixture.input, title: "Retained" });
  const recordBytes = await fs.readFile(path.join(fixture.documentDirectory, "metadata.json"));
  const deleter = await createDocumentDeleter(fixture);
  const result = await deleter(fixture.metadata.id);

  assert.deepEqual(result, {
    metadata: fixture.metadata,
    reclaimedBytes: fixture.input.originalBytes.length + recordBytes.length,
  });
  await assert.rejects(fs.lstat(fixture.documentDirectory), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(fixture.trashDirectory), []);
  assert.deepEqual(await new LocalDocumentSource(fixture).listDocuments(), [retained]);
  assert.equal(await deleter(fixture.metadata.id), null);
});

for (const id of ["Legacy_Report-2026", "a".repeat(255)]) {
  test(`deletion accepts legacy metadata and safe IDs of length ${id.length}`, async (t) => {
    const fixture = await deletionFixture(t, id);
    const { schemaVersion, ...legacy } = fixture.metadata;
    await fs.writeFile(path.join(fixture.documentDirectory, "metadata.json"), JSON.stringify(legacy));
    const originalRename = fs.rename;
    const destinations: string[] = [];
    t.mock.method(fs, "rename", async (...args: Parameters<typeof originalRename>) => {
      destinations.push(String(args[1]));
      return originalRename(...args);
    });

    const result = await (await createDocumentDeleter(fixture))(id);
    assert.deepEqual(result?.metadata, fixture.metadata);
    assert.equal(destinations.length, 1);
    assert.equal(path.dirname(destinations[0]), fixture.trashDirectory);
    assert.match(path.basename(destinations[0]), /^[a-f0-9-]{36}$/);
    assert.deepEqual(await fs.readdir(fixture.trashDirectory), []);
  });
}

test("the CLI backend shares long-ID deletion and rejects corrupt records", async (t) => {
  const fixture = await deletionFixture(t, "b".repeat(255));
  assert.deepEqual((await fixture.backend.deleteDocument(fixture.metadata.id))?.metadata, fixture.metadata);

  const corrupt = await fixture.backend.publish(fixture.input);
  const directory = path.join(fixture.home, "documents", corrupt.id);
  await fs.writeFile(path.join(directory, "metadata.json"), "{");
  await assert.rejects(fixture.backend.deleteDocument(corrupt.id), SyntaxError);
  assert.ok((await fs.lstat(directory)).isDirectory());
});

test("missing documents return null and unsafe IDs never reach storage", async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  assert.equal(await deleter("missing-record"), null);
  const originalHome = await moveHome(t, fixture.home);

  for (const id of ["", "..", "../escape", ".trash", "/absolute", "safe/id", "safe\\id", "%2e%2e", "safe\0id"]) {
    assert.equal(await deleter(id), null);
  }

  await assert.rejects(deleter(fixture.metadata.id), DocumentIdentityError);
  assert.deepEqual((await fs.readdir(path.join(originalHome, "documents"))).sort(), [".staging", ".trash", fixture.metadata.id].sort());
});

test("factory checks never create or harden missing homes, identities, or storage trees", async (t) => {
  const parent = await fs.realpath(await temporaryHome(t));
  const home = path.join(parent, "absent");
  const location = { home, instanceId: randomUUID() };
  await assert.rejects(createDocumentDeleter(location), DocumentIdentityError);
  assert.deepEqual(await fs.readdir(parent), []);

  await fs.mkdir(home, { mode: 0o750 });
  const before = await fileSnapshot(home);
  await assert.rejects(createDocumentDeleter(location), DocumentIdentityError);
  assert.deepEqual(await fileSnapshot(home), before);
  assert.deepEqual(await fs.readdir(home), []);

  await fs.writeFile(path.join(home, "instance-id"), location.instanceId, { mode: 0o640 });
  const identityOnly = await treeSnapshot(home);
  const deleter = await createDocumentDeleter(location);
  await assert.rejects(deleter("missing"), DocumentIdentityError);
  assert.deepEqual(await treeSnapshot(home), identityOnly);
});

test("an identity-only inbox can gain storage after the deleter is created", async (t) => {
  const home = await fs.realpath(await temporaryHome(t));
  const instanceId = (await getInboxInstanceId(home)).toUpperCase();
  await fs.writeFile(path.join(home, "instance-id"), instanceId);
  const deleter = await createDocumentDeleter({ home, instanceId });
  const metadata = await new LocalDocumentBackend(home).publish(publishInput());

  assert.deepEqual((await deleter(metadata.id))?.metadata, metadata);
  assert.deepEqual(await fs.readdir(path.join(home, "documents")), [".staging", ".trash"]);
});

test("factory pins the root inode before the first deletion even when its UUID is copied", async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const originalHome = await moveHome(t, fixture.home);
  await fs.cp(originalHome, fixture.home, { recursive: true });
  const before = await treeSnapshot(fixture.home);

  await assert.rejects(deleter(fixture.metadata.id), DocumentIdentityError);
  assert.deepEqual(await treeSnapshot(fixture.home), before);
  assert.ok((await fs.lstat(path.join(originalHome, "documents", fixture.metadata.id))).isDirectory());
});

for (const replacement of ["missing", "different", "malformed"]) {
  test(`deletion reports ${replacement} UUID identity as a conflict without touching documents`, async (t) => {
    const fixture = await deletionFixture(t);
    const deleter = await createDocumentDeleter(fixture);
    const identityPath = path.join(fixture.home, "instance-id");
    if (replacement === "missing") {
      await fs.rm(identityPath);
    } else {
      await fs.writeFile(identityPath, replacement === "different" ? randomUUID() : "invalid");
    }

    const before = await treeSnapshot(fixture.documentDirectory);
    await assert.rejects(deleter(fixture.metadata.id), DocumentIdentityError);
    assert.deepEqual(await treeSnapshot(fixture.documentDirectory), before);
  });
}

for (const name of ["documents", ".trash"]) {
  for (const replacement of ["missing", "copied"]) {
    test(`deletion refuses ${replacement} required ${name} directory and does not recreate it`, async (t) => {
      const fixture = await deletionFixture(t);
      const deleter = await createDocumentDeleter(fixture);
      const directory = name === "documents" ? path.join(fixture.home, name) : fixture.trashDirectory;
      const original = path.join(await temporaryHome(t), "saved");
      await fs.rename(directory, original);
      if (replacement === "copied") {
        await fs.cp(original, directory, { recursive: true });
      }

      const before = await treeSnapshot(fixture.home);
      await assert.rejects(deleter(fixture.metadata.id), DocumentIdentityError);
      assert.deepEqual(await treeSnapshot(fixture.home), before);
    });
  }
}

test("factory rejects invalid locations and noncanonical roots", posixOnly, async (t) => {
  const fixture = await deletionFixture(t);
  await assert.rejects(createDocumentDeleter({ ...fixture, home: "relative" }), /canonical/);
  await assert.rejects(createDocumentDeleter({ ...fixture, instanceId: "invalid" }), /UUID/);
  const alias = path.join(await temporaryHome(t), "alias");
  await fs.symlink(fixture.home, alias);
  await assert.rejects(createDocumentDeleter({ ...fixture, home: alias }), DocumentIdentityError);
});

for (const corruption of ["invalid JSON", "wrong ID", "unsupported schema", "empty title", "oversized metadata", "missing metadata", "missing HTML", "metadata directory"]) {
  test(`${corruption} is an error rather than a missing document`, async (t) => {
    const fixture = await deletionFixture(t);
    const deleter = await createDocumentDeleter(fixture);
    const metadataPath = path.join(fixture.documentDirectory, "metadata.json");
    if (corruption === "missing metadata" || corruption === "metadata directory") {
      await fs.rm(metadataPath);
      if (corruption === "metadata directory") {
        await fs.mkdir(metadataPath);
      }
    } else if (corruption === "missing HTML") {
      await fs.rm(path.join(fixture.documentDirectory, "index.html"));
    } else {
      const invalid = corruption === "invalid JSON" ? "{"
        : corruption === "oversized metadata" ? " ".repeat(64 * 1024 + 1)
          : JSON.stringify({ ...fixture.metadata, ...(corruption === "wrong ID" ? { id: "other" } : corruption === "empty title" ? { title: "" } : { schemaVersion: 2 }) });
      await fs.writeFile(metadataPath, invalid);
    }

    const before = await treeSnapshot(fixture.documentDirectory);
    await assert.rejects(deleter(fixture.metadata.id), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof DocumentIdentityError, false);
      assert.equal(error instanceof DocumentCleanupError, false);
      return true;
    });
    assert.deepEqual(await treeSnapshot(fixture.documentDirectory), before);
    assert.deepEqual(await fs.readdir(fixture.trashDirectory), []);
  });
}

for (const name of ["root", "documents", ".trash", "record", "instance-id", "metadata.json", "index.html", "extra"]) {
  test(`deletion rejects ${name} symlinks without changing their targets`, posixOnly, async (t) => {
    const fixture = await deletionFixture(t);
    const deleter = await createDocumentDeleter(fixture);
    const linkPath = managedPath(fixture, name);
    const destination = path.join(await temporaryHome(t), "target");
    if (name === "extra") {
      await fs.writeFile(destination, "external", { mode: 0o640 });
    } else {
      await fs.rename(linkPath, destination);
    }

    await fs.symlink(destination, linkPath);
    const before = await treeSnapshot(destination);
    await assert.rejects(deleter(fixture.metadata.id));
    assert.deepEqual(await treeSnapshot(destination), before);
    assert.ok((await fs.lstat(linkPath)).isSymbolicLink());
  });
}

for (const name of ["instance-id", "metadata.json", "index.html", "extra"]) {
  test(`deletion rejects ${name} hardlinks before changing file permissions`, posixOnly, async (t) => {
    const fixture = await deletionFixture(t);
    const deleter = await createDocumentDeleter(fixture);
    const file = managedPath(fixture, name);
    if (name === "extra") {
      await fs.writeFile(file, "extra", { mode: 0o640 });
    }

    const target = path.join(await temporaryHome(t), "linked");
    await fs.link(file, target);
    const before = await fileSnapshot(target);
    await assert.rejects(deleter(fixture.metadata.id));
    assert.deepEqual(await fileSnapshot(target), before);
    assert.ok((await fs.lstat(fixture.documentDirectory)).isDirectory());
  });
}

for (const name of ["root", "documents", ".trash", "record", "instance-id", "metadata.json", "index.html"]) {
  test(`deletion rejects a nonowner ${name} before writes`, { skip: !process.getuid }, async (t) => {
    const fixture = await deletionFixture(t);
    const deleter = await createDocumentDeleter(fixture);
    const file = managedPath(fixture, name);
    const before = await treeSnapshot(fixture.home);
    const originalLstat = fs.lstat;
    const checked = t.mock.method(fs, "lstat", async (filePath: Parameters<typeof originalLstat>[0]) => {
      const info = await originalLstat(filePath);
      if (filePath === file) {
        info.uid = (process.getuid?.() ?? info.uid) + 1;
      }

      return info;
    });
    await assert.rejects(deleter(fixture.metadata.id));
    checked.mock.restore();
    assert.deepEqual(await treeSnapshot(fixture.home), before);
  });
}

test("deletion rejects special files without opening or chmodding them", posixOnly, async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const fifo = path.join(fixture.documentDirectory, "extra");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const before = await fileSnapshot(fifo);

  await assert.rejects(deleter(fixture.metadata.id), /regular file/);
  assert.deepEqual(await fileSnapshot(fifo), before);
  assert.ok((await fs.lstat(fixture.documentDirectory)).isDirectory());
});

test("a metadata symlink substituted before open never changes the target", posixOnly, async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const metadataPath = path.join(fixture.documentDirectory, "metadata.json");
  const target = path.join(await temporaryHome(t), "target");
  await fs.writeFile(target, JSON.stringify(fixture.metadata), { mode: 0o640 });
  const before = await fileSnapshot(target);
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === metadataPath) {
      await fs.rm(metadataPath);
      await fs.symlink(target, metadataPath);
    }

    return originalOpen(...args);
  });

  await assert.rejects(deleter(fixture.metadata.id));
  assert.deepEqual(await fileSnapshot(target), before);
  assert.ok((await fs.lstat(fixture.documentDirectory)).isDirectory());
});

test("a copied-UUID root replacement during metadata read is an identity error", posixOnly, async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const metadataPath = path.join(fixture.documentDirectory, "metadata.json");
  const originalOpen = fs.open;
  let replacement: Awaited<ReturnType<typeof treeSnapshot>> | undefined;
  t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (args[0] === metadataPath) {
      const originalClose = file.close.bind(file);
      t.mock.method(file, "close", async () => {
        await originalClose();
        const originalHome = await moveHome(t, fixture.home);
        await fs.cp(originalHome, fixture.home, { recursive: true });
        replacement = await treeSnapshot(fixture.home);
      });
    }

    return file;
  });

  await assert.rejects(deleter(fixture.metadata.id), DocumentIdentityError);
  assert.ok(replacement);
  assert.deepEqual(await treeSnapshot(fixture.home), replacement);
});

test("required directories are checked again after preparing the document for rename", posixOnly, async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const savedTrash = path.join(await temporaryHome(t), "saved-trash");
  const originalOpen = fs.open;
  let replaced = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args);
    if (args[0] === fixture.documentDirectory && !replaced) {
      replaced = true;
      await fs.rename(fixture.trashDirectory, savedTrash);
      await fs.cp(savedTrash, fixture.trashDirectory, { recursive: true });
    }

    return file;
  });

  await assert.rejects(deleter(fixture.metadata.id), DocumentIdentityError);
  assert.equal(replaced, true);
  assert.ok((await fs.lstat(fixture.documentDirectory)).isDirectory());
  assert.deepEqual(await fs.readdir(fixture.trashDirectory), []);
  assert.deepEqual(await fs.readdir(savedTrash), []);
});

test("a directory symlink substituted before chmod never changes its target", posixOnly, async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const parent = await temporaryHome(t);
  const target = path.join(parent, "target");
  await fs.mkdir(target, { mode: 0o500 });
  const before = await fileSnapshot(target);
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === fixture.documentDirectory) {
      await fs.rename(fixture.documentDirectory, path.join(parent, "saved-document"));
      await fs.symlink(target, fixture.documentDirectory);
    }

    return originalOpen(...args);
  });

  await assert.rejects(deleter(fixture.metadata.id));
  assert.deepEqual(await fileSnapshot(target), before);
  assert.ok((await fs.lstat(fixture.documentDirectory)).isSymbolicLink());
});

test("concurrent deletions across independently captured deleters commit exactly once", async (t) => {
  const fixture = await deletionFixture(t);
  const deleters = await Promise.all(Array.from({ length: 4 }, () => createDocumentDeleter(fixture)));
  const results = await Promise.all(deleters.flatMap((deleter) => [deleter(fixture.metadata.id), deleter(fixture.metadata.id)]));

  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(results.filter((result) => result === null).length, 7);
  assert.deepEqual(await fs.readdir(fixture.trashDirectory), []);
  await assert.rejects(fs.lstat(fixture.documentDirectory), { code: "ENOENT" });
});

test("rename failure preserves the library and never reports a cleanup error", async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const failure = new Error("rename denied");
  const before = await treeSnapshot(fixture.home);
  t.mock.method(fs, "rename", async () => { throw failure; });

  await assert.rejects(deleter(fixture.metadata.id), (error: unknown) => error === failure);
  assert.deepEqual(await treeSnapshot(fixture.home), before);
});

test("partial purge failure reports committed metadata and cause without resurrecting the document", async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const failure = new Error("disk denied cleanup");
  const originalRm = fs.rm;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof originalRm>) => {
    const directory = String(args[0]);
    if (path.dirname(directory) === fixture.trashDirectory) {
      await originalRm(path.join(directory, "index.html"));
      throw failure;
    }

    return originalRm(...args);
  });

  await assert.rejects(deleter(fixture.metadata.id), (error: unknown) => {
    assert.ok(error instanceof DocumentCleanupError);
    assert.deepEqual(error.metadata, fixture.metadata);
    assert.equal(error.cause, failure);
    return true;
  });
  await assert.rejects(fs.lstat(fixture.documentDirectory), { code: "ENOENT" });
  assert.equal(await deleter(fixture.metadata.id), null);
  const quarantined = await fs.readdir(fixture.trashDirectory);
  assert.equal(quarantined.length, 1);
  assert.deepEqual(await fs.readdir(path.join(fixture.trashDirectory, quarantined[0])), ["metadata.json"]);
});

test("root replacement after commit reports cleanup failure and preserves the replacement", async (t) => {
  const fixture = await deletionFixture(t);
  const deleter = await createDocumentDeleter(fixture);
  const originalRename = fs.rename;
  let replacement: Awaited<ReturnType<typeof treeSnapshot>> | undefined;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof originalRename>) => {
    await originalRename(...args);
    if (args[0] === fixture.documentDirectory) {
      const originalHome = await moveHome(t, fixture.home);
      await fs.cp(originalHome, fixture.home, { recursive: true });
      replacement = await treeSnapshot(fixture.home);
    }
  });

  await assert.rejects(deleter(fixture.metadata.id), (error: unknown) => {
    assert.ok(error instanceof DocumentCleanupError);
    assert.deepEqual(error.metadata, fixture.metadata);
    assert.ok(error.cause instanceof DocumentIdentityError);
    return true;
  });
  assert.ok(replacement);
  assert.deepEqual(await treeSnapshot(fixture.home), replacement);
});

test("cleanup handles read-only document directories after committing the rename", posixOnly, async (t) => {
  const fixture = await deletionFixture(t);
  await fs.mkdir(path.join(fixture.documentDirectory, "nested"));
  await fs.writeFile(path.join(fixture.documentDirectory, "nested", "extra"), "extra");
  await fs.chmod(path.join(fixture.documentDirectory, "nested"), 0o500);
  await fs.chmod(fixture.documentDirectory, 0o500);
  const deleter = await createDocumentDeleter(fixture);

  assert.deepEqual((await deleter(fixture.metadata.id))?.metadata, fixture.metadata);
  assert.deepEqual(await fs.readdir(fixture.trashDirectory), []);
});

async function deletionFixture(t: TestContext, id?: string) {
  const home = await fs.realpath(await temporaryHome(t));
  const instanceId = await getInboxInstanceId(home);
  const backend = new LocalDocumentBackend(home, undefined, id ? () => id : undefined);
  const input = publishInput();
  const metadata = await backend.publish(input);

  return {
    home, instanceId, backend, input, metadata,
    documentDirectory: path.join(home, "documents", metadata.id),
    trashDirectory: path.join(home, "documents", ".trash"),
  };
}

function publishInput() {
  return {
    originalBytes: Buffer.from("\ufeff<!doctype html>\r\n<html><body>Original π</body></html>\r\n"),
    title: "Original title",
    type: "report",
    sourceFileName: "original.html",
  };
}

function managedPath(fixture: Awaited<ReturnType<typeof deletionFixture>>, name: string) {
  return name === "root" ? fixture.home
    : name === "documents" ? path.join(fixture.home, name)
      : name === ".trash" ? fixture.trashDirectory
        : name === "instance-id" ? path.join(fixture.home, name)
          : name === "record" ? fixture.documentDirectory : path.join(fixture.documentDirectory, name);
}

async function fileSnapshot(file: string) {
  const info = await fs.lstat(file);
  return {
    info: { mode: info.mode, uid: info.uid, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs },
    bytes: info.isFile() ? await fs.readFile(file) : undefined,
  };
}

async function treeSnapshot(directory: string) {
  const info = await fs.lstat(directory);
  const names = info.isDirectory() ? ["", ...await fs.readdir(directory, { recursive: true })].sort() : [""];
  return Promise.all(names.map(async (name) => ({ name, ...await fileSnapshot(path.join(directory, name)) })));
}

async function moveHome(t: TestContext, home: string) {
  const destination = path.join(await temporaryHome(t), "original");
  await fs.rename(home, destination);
  return destination;
}
