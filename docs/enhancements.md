# Enhancement Audit

This audit covers `origin/main` at `f7fb911`. It deliberately excludes the CDN policy and the
HTML Inbox skill text, which are being changed independently.

## Product boundary

HTML Inbox is strongest as a small, local, single-user library for generated HTML. The next
work should make that promise true under failure and make a growing inbox manageable. It should
not turn the prototype into a hosted document platform.

## Now: release blockers

These are must-have fixes before describing the inbox as private or distributing the CLI.

### 1. Enforce the local privacy boundary

**User impact:** Reports may contain sensitive local data. Today the home and document
directories and files use the process umask, even though the product is described as a “local
private document library.” On a permissive or shared machine, another local account could read
them. The HTTP server also routes requests without validating `Host`; that leaves localhost data
available to DNS-rebinding-style requests, including the absolute inbox path returned by
`/health`.

**Implementation seam:**

- Create the inbox and document directories as owner-only (`0700`) and stored files as
  owner-readable/writable (`0600`); safely tighten existing managed paths on startup.
- Reject requests whose normalized `Host` is not the configured loopback host and port before
  routing. Add a regression request with an attacker-controlled Host header.
- Avoid exposing the absolute home path as general health data. If viewer reuse must distinguish
  homes, compare an opaque instance identifier stored with owner-only permissions.

Evidence: `LocalDocumentBackend.publish` and `writeViewerInfo` rely on default modes in
`packages/cli/src/backend.ts` and `packages/cli/src/viewer.ts`; `routeRequest` never checks
`request.headers.host`, while `/health` returns `home`.

### 2. Make a publish atomic and corruption-tolerant

**User impact:** A crash between directory creation, HTML writing, and metadata writing leaves a
partial document. Listing silently hides malformed entries, while opening malformed metadata can
produce a viewer-wide 500. A metadata file whose `id` differs from its directory can also produce
misdirected list links.

**Implementation seam:** Write both files into an owner-only temporary sibling directory, validate
the completed record, then atomically rename it to `documents/<id>`. On reads, require the metadata
ID to equal the directory ID and distinguish “missing,” “corrupt,” and unexpected I/O errors.
Skip or quarantine one corrupt record with a useful diagnostic instead of hiding every error or
failing the request generically.

Evidence: `LocalDocumentBackend.publish`, `readMetadata`, and `getDocument` in
`packages/cli/src/backend.ts`.

### 3. Put explicit bounds on untrusted input

**User impact:** `publish` loads the entire file into memory and accepts unbounded title/type
metadata. An accidental huge export can exhaust memory or disk, and pathological metadata makes
the index unusable.

**Implementation seam:** Check `stat.size` before `readFile`, choose and document a conservative
configurable HTML limit, cap title/type/source-name lengths, and report actual versus allowed size.
Keep streaming and quotas out until real usage requires them.

Evidence: `readPublishInput` in `packages/cli/src/index.ts` reads bytes only after an unbounded
`stat`; `assertDocumentMetadata` checks only for non-empty strings in
`packages/shared/src/index.ts`.

### 4. Establish a clean-checkout release contract

**User impact:** The repository has no installation or supported-runtime instructions, both
packages are private, and each test script executes generated `dist` files without building them.
A successful test after a prior local build is therefore weaker than a clean-checkout test, and
the CLI is not yet consumable as a normal package.

**Implementation seam:**

- Decide whether the supported install is an npm package, a packed local tarball, or a repository
  command; document exactly one path first.
- Declare the Node runtime, add `--help` and `--version`, and make the package entry point part of a
  `pnpm pack` smoke test.
- Make the root verification command build from clean sources before executing self-checks. Add CI
  for that exact command.
- Exercise the public CLI in a temporary home, not only imported functions, and clean the temp
  directory after the test.

Evidence: root and package `package.json` files, `packages/*/src/self-check.ts`, and the absence of
a repository README or CI workflow.

## Next: make the inbox usable

These are high-value features once the release blockers are closed.

### Delete and retention, CLI first

An inbox that only accumulates files eventually becomes a liability. Add `list` and
`delete <id>` to the CLI, with an explicit confirmation or `--force` for interactive use. Keep the
first deletion path off HTTP so it does not introduce browser mutation endpoints and CSRF work.
Delete via atomic rename to a trash directory before recursive removal; show the reclaimed bytes.

### Search and useful metadata

The viewer already sorts metadata, so add a server-rendered query over title, type, and source file
name before considering an index or database. Show source file name, human-readable time with a
machine-readable `<time datetime>`, document size, and a stable short ID. Add pagination only after
the measured list size makes it necessary.

### Observable viewer lifecycle

Detached startup currently turns port conflicts and early crashes into a generic three-second
timeout, and there is no supported status or stop command. Add `viewer status` and `viewer stop`,
surface `EADDRINUSE` directly, and include a protocol/version value in health checks before the
storage or viewer protocol evolves. Either make `viewer.json` the validated lifecycle record or
remove it; a write-only PID file is misleading.

### Storage and protocol versions

Add a small schema version to metadata and a protocol version to `/health` before adding new stored
fields or commands. Readers should reject unsupported future versions clearly. Do not build a
migration framework yet: one version switch and one documented upgrade function are enough.

## Later: only after demand

- **Export/backup:** A deterministic archive command is useful once users depend on the inbox.
  Plain files already make manual backup possible, so cloud sync is not required now.
- **Tags or pinned documents:** Add only if title/type/source search is insufficient in observed
  libraries.
- **Duplicate detection:** A content hash can warn about repeated publishes, but storage pressure
  should be measured first.
- **Viewer polish:** Keyboard focus, responsive iframe sizing, and clearer empty/error states are
  worthwhile after core management commands exist.

## Explicit YAGNI line

Do not add authentication, remote hosting, sync, a database, a plugin backend, a sanitizer
framework, or multi-user permissions to this local single-user phase. Each expands the threat
model more than it improves the current job.

The current abstraction budget also has three candidates to simplify; these are not blockers and
should be handled only when they do not conflict with active work:

- `delete:` stop writing `viewer.json` unless status/stop reads and validates it. Replacement:
  nothing. [`packages/cli/src/viewer.ts`]
- `yagni:` the `DocumentBackend` interface and separate shared workspace have one runtime consumer
  and one implementation. Replacement: co-locate the types with the CLI until a second real
  backend or consumer exists. [`packages/shared`, `packages/cli/src/backend.ts`]
- `shrink:` `PublishInput.html` is carried into the backend but never read there. Replacement:
  validate locally and pass the original bytes once. [`packages/shared/src/index.ts`,
  `packages/cli/src/index.ts`]

Potential net simplification: about 45 lines and one workspace package, with no external
dependency change.

## Suggested acceptance gate

A release candidate is ready when a clean checkout can run one documented verification command;
publish a bounded file into an owner-only temporary home; survive a simulated mid-publish failure
without exposing a partial document; reject a hostile Host header; list and open the stored
document; and pack/run the advertised CLI entry point.
