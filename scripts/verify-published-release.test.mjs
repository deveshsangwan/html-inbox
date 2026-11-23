import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { verifyPublishedRelease } from "./verify-published-release.mjs";

const release = { version: "0.6.3", tag: "latest", expectedIntegrity: "sha512-fixture" };
const manifest = { name: "html-inbox", version: release.version, dist: { integrity: release.expectedIntegrity } };
const manifestPath = "/html-inbox/0.6.3";
const tagsPath = "/-/package/html-inbox/dist-tags";

async function serveRegistry(t, handler) {
  const registry = createServer(handler);
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    const closed = new Promise(resolve => registry.close(resolve));
    registry.closeAllConnections();
    return closed;
  });

  const signals = new Set();
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, init) => {
    assert.equal(new URL(url).origin, "https://registry.npmjs.org");
    assert.equal(init.cache, "no-store");
    signals.add(init.signal);
    return fetch(`http://127.0.0.1:${registry.address().port}${new URL(url).pathname}`, init);
  });
  return signals;
}

test("confirmation waits for the public version and selected tag, then accepts an exact match", async t => {
  const paths = [];
  const replies = [
    [404, {}],
    [200, manifest], [200, {}],
    [200, manifest], [200, { node20: "0.6.2" }],
    [200, manifest], [200, { node20: release.version, latest: "1.0.0" }],
  ];

  const signals = await serveRegistry(t, (request, response) => {
    paths.push(request.url);
    const [status, value] = replies.shift() ?? [500, {}];
    response.writeHead(status).end(JSON.stringify(value));
  });

  await verifyPublishedRelease({ ...release, tag: "node20", budgetMs: 10_000, retryMs: 5 });
  assert.equal(signals.size, 1);
  assert.deepEqual(paths, [manifestPath, manifestPath, tagsPath, manifestPath, tagsPath, manifestPath, tagsPath]);
});

test("confirmation rejects a mismatched archive and malformed tag values without retrying", async t => {
  let packageMetadata = { ...manifest, dist: { integrity: "sha512-other" } };
  let tagBody;
  const paths = [];
  await serveRegistry(t, (request, response) => {
    paths.push(request.url);
    response.end(request.url === manifestPath ? JSON.stringify(packageMetadata) : tagBody);
  });

  const confirm = () => verifyPublishedRelease({ ...release, budgetMs: 3_000 });
  await assert.rejects(confirm, /identity or integrity differs/);
  assert.deepEqual(paths.splice(0), [manifestPath]);

  packageMetadata = manifest;
  for (const [body, error] of [
    [JSON.stringify({ latest: "0.6.3\n" }), /invalid stable version/],
    [JSON.stringify({ latest: ["0.6.3"] }), /invalid stable version/],
    ["null", /not a tag object/],
    ["{", SyntaxError],
  ]) {
    tagBody = body;
    await assert.rejects(confirm, error);
    assert.deepEqual(paths.splice(0), [manifestPath, tagsPath]);
  }
});

for (const slowPath of [manifestPath, tagsPath]) {
  test(`one verification deadline cancels a partial HTTP body at ${slowPath}`, { timeout: 8_000 }, async t => {
    let startedBody = false;
    await serveRegistry(t, (request, response) => {
      if (request.url !== slowPath) {
        response.end(JSON.stringify(manifest));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      startedBody = true;
    });

    await assert.rejects(verifyPublishedRelease({ ...release, budgetMs: 1_000 }), /still unconfirmed.*inspect npm/);
    assert.equal(startedBody, true);
  });
}
