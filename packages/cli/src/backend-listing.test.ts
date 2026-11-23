import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { LocalDocumentBackend } from "./backend";
import { temporaryHome } from "./test-fixtures";

async function seed(home: string, count: number) {
  const metadata = [];

  for (let index = 0; index < count; index += 1) {
    const id = `document-${String(index).padStart(3, "0")}`;
    const directory = path.join(home, "documents", id);
    const record = {
      schemaVersion: 1,
      id,
      title: id,
      type: "report",
      sourceFileName: "fixture.html",
      createdAt: index % 2 ? "2026-11-07T00:00:00.000Z" : "2026-11-06T00:00:00.000Z",
    };

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "metadata.json"), JSON.stringify(record));
    await fs.writeFile(path.join(directory, "index.html"), "<html>fixture</html>");

    metadata.push(record);
  }

  return metadata.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

// Neither ascending nor descending, so tied records cannot match by ID order alone.
function interleaveByThree(names: string[]) {
  const sorted = [...names].sort();

  return [2, 0, 1].flatMap((remainder) => sorted.filter((_, index) => index % 3 === remainder));
}

async function enumerateInOrder(readdir: typeof fs.readdir, directory: string, enumeration: string[]) {
  const storageEntries = (await readdir(directory)).filter((name) => !enumeration.includes(name));

  return [...enumeration, ...storageEntries];
}

function inEnumerationOrder<T extends { id: string; createdAt: string }>(records: T[], enumeration: string[]) {
  return [...records]
    .sort((left, right) => enumeration.indexOf(left.id) - enumeration.indexOf(right.id))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

test("ordinary listings share a read limit across instances and keep enumeration order for ties", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const records = await seed(home, 96);
  const documentsDirectory = path.join(home, "documents");
  const enumeration = interleaveByThree(records.map((record) => record.id));
  const expected = inEnumerationOrder(records, enumeration);
  const createdAtById = new Map(records.map((record) => [record.id, record.createdAt]));
  const tiedPartnerId = enumeration.slice(1).find((id) => createdAtById.get(id) === createdAtById.get(enumeration[0]));
  assert.ok(tiedPartnerId);
  const delayedFile = path.join(documentsDirectory, enumeration[0], "metadata.json");
  const tiedPartnerFile = path.join(documentsDirectory, tiedPartnerId, "metadata.json");
  const listingCount = 3;
  const readdir = fs.readdir;
  const readFile = fs.readFile;
  let activeReads = 0;
  let peakReads = 0;
  let tiedPartnerReads = 0;
  let releaseDelayedReads = () => {};
  const tiedPartnerReadEverywhere = new Promise<void>((resolve) => { releaseDelayedReads = resolve; });

  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    return String(args[0]) === documentsDirectory ? enumerateInOrder(readdir, documentsDirectory, enumeration) : readdir(...args);
  });

  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const file = String(args[0]);

    if (!file.endsWith("metadata.json")) {
      return readFile(...args);
    }

    activeReads += 1;
    peakReads = Math.max(peakReads, activeReads);

    try {
      await setImmediate();
      const bytes = await readFile(...args);

      if (file === tiedPartnerFile) {
        tiedPartnerReads += 1;

        if (tiedPartnerReads === listingCount) {
          releaseDelayedReads();
        }
      }

      // Each listing reads the partner once, so in every listing a later tied record finishes before the first one.
      if (file === delayedFile) {
        await tiedPartnerReadEverywhere;
      }

      return bytes;
    } finally {
      activeReads -= 1;
    }
  });

  const backends = Array.from({ length: listingCount }, () => new LocalDocumentBackend(home));
  const listings = backends.map((backend) => backend.listDocuments());
  try {
    const results = await Promise.all(listings);

    for (const result of results) {
      assert.deepEqual(result, expected);
    }

    assert.ok(peakReads > 1);
    assert.ok(peakReads <= 8, `aggregate active reads: ${peakReads}`);
    assert.equal(activeReads, 0);
  } finally {
    releaseDelayedReads();
    await Promise.allSettled(listings);
  }
});

test("a failed listing keeps its first error and skips queued reads while a waiting listing completes", { timeout: 10_000 }, async (t) => {
  const failingHome = await temporaryHome(t);
  const healthyHome = await temporaryHome(t);
  const failingRecords = await seed(failingHome, 24);
  const failingEnumeration = failingRecords.map((record) => record.id).sort();
  const failingDocuments = path.join(failingHome, "documents");
  const healthyRecords = await seed(healthyHome, 48);
  const healthyEnumeration = interleaveByThree(healthyRecords.map((record) => record.id));
  const expected = inEnumerationOrder(healthyRecords, healthyEnumeration);
  const healthyDocuments = path.join(healthyHome, "documents");
  const readdir = fs.readdir;
  const readFile = fs.readFile;
  const lstat = fs.lstat;
  const heldReads: Array<(error?: Error) => void> = [];
  let failingReads = 0;
  let activeFailingReads = 0;
  let healthyReads = 0;
  let activeHealthyReads = 0;
  let isCountingAdmissions = false;
  let healthyEnumerations = 0;
  let admittedRecords = 0;
  let releaseEnumerations = () => {};
  const bothEnumerated = new Promise<void>((resolve) => { releaseEnumerations = resolve; });
  let releaseAdmissions = () => {};
  const admissionsCounted = new Promise<void>((resolve) => { releaseAdmissions = resolve; });
  let reportEightHeld = () => {};
  const eightHeld = new Promise<void>((resolve) => { reportEightHeld = resolve; });
  let reportHealthyEnumerated = () => {};
  const healthyEnumerated = new Promise<void>((resolve) => { reportHealthyEnumerated = resolve; });

  // The failing home lists a real record ninth, so a worker that ignores the failure would make a counted read.
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === failingDocuments) {
      return enumerateInOrder(readdir, failingDocuments, failingEnumeration);
    }

    if (String(args[0]) !== healthyDocuments) {
      return readdir(...args);
    }

    const entries = await enumerateInOrder(readdir, healthyDocuments, healthyEnumeration);
    reportHealthyEnumerated();

    if (isCountingAdmissions) {
      healthyEnumerations += 1;

      if (healthyEnumerations === 2) {
        releaseEnumerations();
      }

      await bothEnumerated;
    }

    return entries;
  });

  // Hardening starts with lstat on the record directory as soon as a worker holds a permit.
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const file = String(args[0]);

    if (isCountingAdmissions && path.dirname(file) === healthyDocuments && healthyEnumeration.includes(path.basename(file))) {
      admittedRecords += 1;
      await admissionsCounted;
    }

    return lstat(...args);
  });

  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const file = String(args[0]);

    if (!file.endsWith("metadata.json")) {
      return readFile(...args);
    }

    if (file.startsWith(failingHome + path.sep)) {
      failingReads += 1;
      activeFailingReads += 1;

      try {
        const bytes = await readFile(...args);

        // Only the first eight reads are held; later ones would come from a worker that ignored the failure.
        if (heldReads.length < 8) {
          const error = await new Promise<Error | undefined>((resolve) => {
            heldReads.push(resolve);

            if (heldReads.length === 8) {
              reportEightHeld();
            }
          });

          if (error) {
            throw error;
          }
        }

        return bytes;
      } finally {
        activeFailingReads -= 1;
      }
    }

    healthyReads += 1;
    activeHealthyReads += 1;

    try {
      await setImmediate();
      return await readFile(...args);
    } finally {
      activeHealthyReads -= 1;
    }
  });

  let activeFailingReadsAtSettlement = -1;
  const failing = new LocalDocumentBackend(failingHome).listDocuments().then(() => undefined, (error: unknown) => error)
    .finally(() => { activeFailingReadsAtSettlement = activeFailingReads; });
  await eightHeld;

  let isHealthySettled = false;
  const pending: Promise<unknown>[] = [failing];
  try {
    const healthy = new LocalDocumentBackend(healthyHome).listDocuments().finally(() => { isHealthySettled = true; });
    pending.push(healthy);
    await healthyEnumerated;
    await setImmediate();
    assert.equal(healthyReads, 0, "the second listing waits while the first holds all eight permits");
    assert.equal(isHealthySettled, false);

    // This worker finishes, claims another record and queues behind the waiting listing.
    heldReads[7]();
    await setImmediate();

    const firstError = Object.assign(new Error("first synthetic failure"), { code: "EACCES" });
    heldReads[0](firstError);
    await setImmediate();
    heldReads[1](Object.assign(new Error("sibling synthetic failure"), { code: "EACCES" }));

    for (const release of heldReads.slice(2, 7)) {
      release();
    }

    assert.equal(await failing, firstError);
    assert.equal(activeFailingReadsAtSettlement, 0, "the failed listing drains its own reads before rejecting");
    assert.equal(failingReads, 8, "the queued worker skips its read after receiving a permit");
    assert.deepEqual(await healthy, expected);
    assert.equal(activeHealthyReads, 0);

    // Both listings enumerate together, so their sixteen workers ask for permits in one turn. Exactly eight
    // may be admitted: a leaked permit admits fewer, and a permit released twice admits more.
    isCountingAdmissions = true;
    const concurrent = [0, 1].map(() => new LocalDocumentBackend(healthyHome).listDocuments());
    pending.push(...concurrent);
    await bothEnumerated;
    await setImmediate();
    assert.equal(admittedRecords, 8);

    releaseAdmissions();
    assert.deepEqual(await Promise.all(concurrent), [expected, expected]);
  } finally {
    releaseEnumerations();
    releaseAdmissions();
    for (const release of heldReads) {
      release();
    }

    await Promise.allSettled(pending);
  }
});

test("waiting listings receive released permits in arrival order", { timeout: 10_000 }, async (t) => {
  const holdingHome = await temporaryHome(t);
  const firstHome = await temporaryHome(t);
  const secondHome = await temporaryHome(t);
  const holdingRecords = await seed(holdingHome, 8);
  const holdingEnumeration = holdingRecords.map((record) => record.id).sort();
  const holdingDocuments = path.join(holdingHome, "documents");
  const firstExpected = await seed(firstHome, 1);
  const secondExpected = await seed(secondHome, 1);
  const readdir = fs.readdir;
  const readFile = fs.readFile;
  const heldReads: Array<() => void> = [];
  const enumerationSignals = new Map<string, () => void>();
  const settlementOrder: string[] = [];
  let reportEightHeld = () => {};
  const eightHeld = new Promise<void>((resolve) => { reportEightHeld = resolve; });

  // Records come before storage directories, so the holding listing's eight workers all read real records.
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const directory = String(args[0]);
    const entries = directory === holdingDocuments
      ? await enumerateInOrder(readdir, holdingDocuments, holdingEnumeration)
      : await readdir(...args);

    enumerationSignals.get(directory)?.();
    return entries;
  });

  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await readFile(...args);
    const file = String(args[0]);

    if (file.startsWith(holdingDocuments + path.sep) && file.endsWith("metadata.json")) {
      await new Promise<void>((resolve) => {
        heldReads.push(resolve);

        if (heldReads.length === 8) {
          reportEightHeld();
        }
      });
    }

    return bytes;
  });

  const holding = new LocalDocumentBackend(holdingHome).listDocuments();
  const pending = [holding];

  const startWaitingListing = async (home: string, label: string) => {
    const enumerated = new Promise<void>((resolve) => { enumerationSignals.set(path.join(home, "documents"), resolve); });
    const listing = new LocalDocumentBackend(home).listDocuments().then((documents) => {
      settlementOrder.push(label);
      return documents;
    });

    pending.push(listing);
    await enumerated;
    await setImmediate();
    return { listing };
  };

  await eightHeld;
  try {
    const first = await startWaitingListing(firstHome, "first");
    const second = await startWaitingListing(secondHome, "second");

    // One permit circulates: every waiter of the earlier listing is served before any waiter of the later one.
    heldReads[0]();
    assert.deepEqual(await Promise.all([first.listing, second.listing]), [firstExpected, secondExpected]);
    assert.deepEqual(settlementOrder, ["first", "second"]);
  } finally {
    for (const release of heldReads) {
      release();
    }

    await Promise.allSettled(pending);
  }

  assert.equal((await holding).length, 8);
});

test("a listing rejects with the exact value its warning callback throws, even undefined", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  await seed(home, 3);
  await fs.writeFile(path.join(home, "documents", "document-001", "metadata.json"), "{");
  const backend = new LocalDocumentBackend(home, () => {
    throw undefined;
  });

  let rejection: unknown = "not rejected";
  await backend.listDocuments().catch((error: unknown) => { rejection = error; });
  assert.equal(rejection, undefined);
});

test("ordinary listing retains corruption diagnostics, unsafe-entry handling and permission hardening", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const expected = await seed(home, 8);
  const directory = (index: number) => path.join(home, "documents", `document-00${index}`);
  await fs.writeFile(path.join(directory(1), "metadata.json"), "{");
  await fs.rm(path.join(directory(2), "index.html"));
  await fs.rm(directory(3), { recursive: true });
  await fs.symlink(directory(0), directory(3));
  await fs.rm(path.join(directory(4), "metadata.json"));
  await fs.symlink(path.join(directory(0), "metadata.json"), path.join(directory(4), "metadata.json"));
  const mismatched = JSON.parse(await fs.readFile(path.join(directory(6), "metadata.json"), "utf8"));
  await fs.writeFile(path.join(directory(6), "metadata.json"), JSON.stringify({ ...mismatched, id: "document-999" }));
  await fs.rm(path.join(directory(7), "index.html"));
  await fs.symlink(path.join(directory(0), "index.html"), path.join(directory(7), "index.html"));
  await fs.mkdir(path.join(home, "documents", "unsafe name"));
  await fs.chmod(directory(0), 0o755);
  await fs.chmod(path.join(directory(0), "metadata.json"), 0o644);
  const warnings: string[] = [];
  const backend = new LocalDocumentBackend(home, (message) => warnings.push(message));

  assert.deepEqual(await backend.listDocuments(), expected.filter((record) => ["document-000", "document-005"].includes(record.id)));
  assert.equal(warnings.length, 6);

  for (const id of [1, 2, 3, 4, 6, 7]) {
    assert.ok(warnings.some((message) => message.includes(`skipping corrupt document document-00${id}:`)));
  }

  if (process.platform !== "win32") {
    assert.equal((await fs.stat(directory(0))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(directory(0), "metadata.json"))).mode & 0o777, 0o600);
  }

  await fs.rm(directory(5), { recursive: true });
  assert.equal(await backend.getDocumentMetadata("document-005"), null);
});

for (const code of ["EACCES", "ENOENT"]) {
  test(`hardening drains its sibling before reporting ${code}`, { timeout: 10_000 }, async (t) => {
    const home = await temporaryHome(t);
    await seed(home, 1);
    const warnings: string[] = [];
    let releaseHtml = () => {};
    const htmlGate = new Promise<void>((resolve) => { releaseHtml = resolve; });
    let reportFailure = () => {};
    const failureStarted = new Promise<void>((resolve) => { reportFailure = resolve; });
    const failure = Object.assign(new Error("synthetic chmod failure"), { code });
    const chmod = fs.chmod;

    t.mock.method(fs, "chmod", async (...args: Parameters<typeof chmod>) => {
      if (String(args[0]).endsWith("index.html")) {
        await htmlGate;
      }

      if (String(args[0]).endsWith("metadata.json")) {
        reportFailure();
        throw failure;
      }

      return chmod(...args);
    });

    let hasSettled = false;
    const backend = new LocalDocumentBackend(home, (message) => warnings.push(message));
    const outcome = backend.listDocuments().catch((error: unknown) => error)
      .finally(() => { hasSettled = true; });

    try {
      await failureStarted;
      await setImmediate();
      assert.equal(hasSettled, false);
      assert.deepEqual(warnings, []);
    } finally {
      releaseHtml();
      await outcome;
    }

    if (code === "ENOENT") {
      assert.deepEqual(await outcome, []);
      assert.deepEqual(warnings, ["skipping corrupt document document-000: document files are incomplete"]);
    } else {
      assert.equal(await outcome, failure);
      assert.deepEqual(warnings, []);
    }
  });
}

test("a record removed after enumeration remains a silent missing record", { timeout: 10_000 }, async (t) => {
  const home = await temporaryHome(t);
  const expected = await seed(home, 2);
  const missingDirectory = path.join(home, "documents", "document-000");
  const lstat = fs.lstat;
  const warnings: string[] = [];

  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === missingDirectory) {
      await fs.rm(missingDirectory, { recursive: true, force: true });
    }

    return lstat(...args);
  });

  assert.deepEqual(await new LocalDocumentBackend(home, (message) => warnings.push(message)).listDocuments(),
    expected.filter((record) => record.id !== "document-000"));
  assert.deepEqual(warnings, []);
});
