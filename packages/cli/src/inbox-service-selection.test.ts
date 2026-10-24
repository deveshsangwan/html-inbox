import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createInbox } from "./inbox-catalog";
import { main } from "./index";
import { temporaryHome } from "./test-fixtures";
import * as viewerService from "./viewer-service";
import { inspectInboxHome } from "./inbox-home";
import { assertManagedLifecycle } from "./sync-lifecycle";

test("service selection validates the target user's explicitly selected registered home before manager access", async (t) => {
  const root = await realpath(await temporaryHome(t));
  const catalogHome = path.join(root, "catalog");
  const target = await createInbox("reader", path.join(root, "reader-inbox"), catalogHome);
  const previousEnvironment = {
    HTML_INBOX_HOME: process.env.HTML_INBOX_HOME,
    HTML_INBOX_NAME: process.env.HTML_INBOX_NAME,
    HTML_INBOX_CATALOG_HOME: process.env.HTML_INBOX_CATALOG_HOME,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  delete process.env.HTML_INBOX_HOME;
  delete process.env.HTML_INBOX_NAME;
  process.env.HTML_INBOX_CATALOG_HOME = catalogHome;

  t.mock.method(viewerService, "resolveViewerServiceHome", async (options: { user?: string }) => {
    assert.equal(options.user, "reader");
    return target.home;
  });
  t.mock.method(viewerService, "inspectViewerServiceSelection", async (home: string, user: string | undefined) => {
    assert.equal(user, "reader");
    const inspected = await inspectInboxHome(home);
    await assertManagedLifecycle(home);
    return { home: inspected.home, instanceId: inspected.instanceId ?? null, managed: false, configuration: null, tailscaleExecutable: null };
  });
  const accessedHomes: string[] = [];
  t.mock.method(viewerService, "getViewerServiceStatus", async (options: { home: string }): Promise<viewerService.ViewerServiceStatus> => {
    accessedHomes.push(options.home);
    return { state: "not-installed", enabled: false, definitionPath: path.join(root, "viewer.service") };
  });
  const diagnostics: string[] = [];
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", (message: string) => { diagnostics.push(message); });

  await main(["viewer", "service", "status", "--user=reader", "--inbox=reader"]);
  assert.deepEqual(accessedHomes, [target.home]);
  assert(diagnostics.some((message) => message.includes("Inbox reader")));

  await writeFile(path.join(target.home, "instance-id"), randomUUID());
  await assert.rejects(main(["viewer", "service", "status", "--user=reader", "--inbox=reader"]), /missing or different identity/);
  assert.deepEqual(accessedHomes, [target.home]);
});
