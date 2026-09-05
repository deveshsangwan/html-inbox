# Code quality audit, 2026-09-05

Reviewed the CLI and shared source, both self-check suites, package smoke test, build and CI configuration, static site source, and architecture and operating documentation. This is a findings and implementation plan. Production code and tests have not been changed.

The local-storage, isolated-viewer, static-export, and deployment-workflow separation is worth keeping. The largest problems are unreliable test completion, incomplete boundary validation, and duplicated representations and processing. A framework rewrite would add work without addressing those problems.

## Evidence from execution

- `corepack pnpm test` exited successfully, but the CLI self-check did not finish. Instrumenting the compiled test in memory showed a child with `exitCode: null` and `signalCode: 'SIGTERM'`, followed by a wait for its already-emitted exit event and Node's `beforeExit` event. The completion callback never ran.
- Correcting that lifecycle condition in memory exposed a failing assertion for an obsolete CSS color. Omitting the two obsolete color assertions in that diagnostic run allowed the remaining self-checks to finish. These diagnostic changes were not written to source or compiled files.
- `corepack pnpm test:package` passed independently.
- An adapter using a recording command runner copied an extra file added after snapshot generation, although the file was absent from the manifest. No Cloudflare command or deployment was executed.
- A saved remote state with an incomplete deployment record passed `RemoteWorkflow.status()`. Formatting it then threw while reading the missing receipt.
- Local and static search disagree for a document titled `Quarterly`, with type `report`, and query `quarterly report`.

## Findings and proposed fixes

1. **The test gate can pass without running most of the CLI checks. Critical.**

   [self-check.ts:298](../packages/cli/src/self-check.ts#L298) waits until `stopViewer()` returns, then subscribes to the child's exit event if `exitCode` is null. A child terminated by a signal keeps a null exit code. Its exit event has already happened in the reproduced run. The unresolved promise does not keep Node alive, so the process exits successfully before the storage, export, adapter, and workflow checks that follow.

   Fix: subscribe to child completion immediately after spawning it, await that existing promise during shutdown, and handle both exit code and signal. Run named tests through Node's test runner so incomplete tests are reported. Verify that an intentional assertion at the end of a temporary diagnostic run fails the command.

2. **The CLI test suite is one long, dependent scenario with incomplete cleanup. High.**

   [self-check.ts:64](../packages/cli/src/self-check.ts#L64) starts a roughly 1,175-line function. Remote deployment checks depend on earlier viewer and storage setup. Numerous temporary homes are never removed, and some servers only get cleanup after earlier assertions have passed. A failure can leave resources behind and hides every later check.

   Fix: separate named tests by input, storage, viewer, export, command runner, adapter, and workflow behavior. Give each case a temporary home and unconditional cleanup. Keep shared fixture helpers small and concrete. Preserve lifecycle tests as integration tests; ordinary storage and workflow tests should not need a running viewer.

3. **Several tests assert implementation details or fail to prove their stated behavior. Medium.**

   [self-check.ts:437](../packages/cli/src/self-check.ts#L437) asserts two obsolete CSS hex values. [package-smoke.mjs:69](../scripts/package-smoke.mjs#L69) requires the executable to exceed 10,000 bytes, which punishes legitimate simplification. Version assertions repeat `0.1.0` in both test suites. Ten repetitions of the same capability encoding check add little coverage. [shared/self-check.ts:96](../packages/shared/src/self-check.ts#L96) checks only `ok` for allowed CDN entries, even though disallowed CDN entries also return `ok` with warnings. Looking for `html-inbox-theme` in downloaded JavaScript does not test theme behavior.

   Fix: delete exact-color and arbitrary-size checks; compare executable version with package metadata; retain one capability format check plus distinct invalid-input cases. Require zero warnings for allowed CDN fixtures. Keep HTTP asset-delivery assertions and add a small browser test for theme persistence, system-theme changes, search, and frame isolation. Preserve the existing corruption, escaping, permission, recovery, and size-limit cases.

4. **JSON validation claims stronger types than it establishes. High.**

   [remote-workflow.ts:588](../packages/cli/src/remote-workflow.ts#L588) casts saved objects through `unknown` to complete state/operation types, then checks only part of each structure. Receipt fields, deployment kind/hash, dates, and phase-specific requirements remain unchecked. This produced the formatter crash described above. Validators in [validation.ts:28](../packages/cli/src/validation.ts#L28) accept already-typed arguments while checking their runtime shape. [shared/index.ts:450](../packages/shared/src/index.ts#L450) mutates legacy metadata inside an assertion function and repeatedly casts fields because its loop does not establish their types.

   Fix: parse unknown input into explicitly constructed domain objects, including nested receipts. Normalize legacy metadata in a parser that returns a new object. Make boundary validators accept unknown where appropriate, then trust their returned types. Preserve missing-file, corrupt-file, and unsupported-version distinctions. Validate receipt target, branch, and capability against the operation before finalization.

5. **The remote-operation model permits impossible combinations. High.**

   [remote-workflow.ts:74](../packages/cli/src/remote-workflow.ts#L74) combines three operation kinds and two phases with optional adoption, previous capability, snapshot hash, and receipt fields. Callers then rediscover which fields must exist through guards and optional chaining. `RemoteStatus.configured` duplicates whether state is null. The deployment port also makes branch and commit metadata optional even though workflow deployment requires them.

   Fix: use a discriminated union for init and snapshot operations, with a receipt required for completed snapshot operations and the previous capability required for revoke. Keep the journal and mutation lock. Require workflow inputs at its deployment boundary. Preserve the external JSON status shape if compatibility matters, deriving `configured` only when formatting that response. Share the common publish/revoke deployment sequence while leaving their differing results explicit.

6. **The snapshot digest is recorded but not checked against deployment input. High.**

   [cloudflare-pages.ts:478](../packages/cli/src/cloudflare-pages.ts#L478) checks that a manifest file exists, then copies every file in the directory. It does not verify the file inventory or digests. [remote-workflow.ts:350](../packages/cli/src/remote-workflow.ts#L350) attaches the saved hash as commit metadata regardless of the current snapshot contents. Recovery can therefore associate a receipt with bytes other than the recorded snapshot.

   Fix: verify the manifest and expected operation hash while preparing the deployment copy. Reject missing, altered, and unexpected files before the command runner is invoked. Define the manifest's own file as an explicit exception to its hashed inventory. Keep this verification at the deployment boundary so retries receive the same protection. Add mutation tests using a recording runner.

7. **The pinned Wrangler adapter guesses at many JSON shapes and silently treats unknown output as an empty result. High.**

   [cloudflare-pages.ts:394](../packages/cli/src/cloudflare-pages.ts#L394) accepts arrays, `result`, `projects`, several field spellings, nested accounts, and recursive arrays of strings. The deployment parser repeats the same pattern. Both accept `{}` as an empty list. Invalid entries are silently dropped. This can turn an output-format mismatch into a conclusion that a project or previous deployment does not exist. `productionUrl` is parsed and asserted in tests but has no production consumer. The deploy method also duplicates the command execution and error handling already in `runWrangler()`.

   Fix: obtain representative JSON fixtures from the exact pinned Wrangler version, implement those supported shapes explicitly, and reject malformed output. Retain compatibility branches only with evidence and a named fixture. Delete unused project URL extraction. Route deploy execution through the existing Wrangler command helper, preserving operation-specific errors and credential redaction.

8. **HTML policy code owns a handwritten partial HTML parser. High maintenance cost.**

   [shared/index.ts:289](../packages/shared/src/index.ts#L289) implements entity decoding, tag scanning, raw-text handling, and attribute parsing. Another regex separately scans script bodies. The raw-text closing matcher at line 377 treats a word boundary after `script` as enough, so a string containing `</script-not-a-close><a href=javascript:alert(1)>` is incorrectly interpreted as markup and blocks publishing. More special cases will grow this parser without making it match browser parsing.

   Fix: replace the scanner and entity decoder with an HTML parser bundled into the executable, after checking bundle cost and supported behavior. Keep HTML policy decisions in a small separate module. Preserve the existing adversarial fixtures and add the reproduced raw-text case. Continue serving original bytes with the sandbox and CSP; parsing must not silently become sanitization. Replace the threaded `add(list, message)` callback with direct diagnostic sets or a small local collector.

9. **Storage repeats record-reading logic and identifies errors by prose. Medium.**

   [backend.ts:102](../packages/cli/src/backend.ts#L102) and line 161 independently handle hardening, missing/incomplete files, parsing, and warnings. Both branch on `error.message.startsWith("Managed ")`. Editing an error message can change whether a corrupt record is skipped or aborts a request.

   Fix: have one record-metadata read path own these decisions and expose a deliberate error type or code for invalid managed files. Preserve ordinary filesystem errors instead of swallowing them. Continue tightening file permissions as documented. Keep path helpers that name storage locations; they clarify ownership and are not useless wrappers.

10. **Metadata-only operations load complete HTML documents. Medium.**

   [index.ts:253](../packages/cli/src/index.ts#L253) loads a document for deletion confirmation, and [backend.ts:141](../packages/cli/src/backend.ts#L141) loads it again during deletion. The viewer shell at [viewer-server.ts:202](../packages/cli/src/viewer-server.ts#L202) loads full content just to render metadata, then the iframe requests the content again. `StoredDocument` holds both a Buffer and its decoded string even when export only needs the Buffer.

   Fix: provide a focused metadata read and use it for shell rendering, confirmation, and deletion. Keep bytes as the canonical stored content and send those bytes directly from the content route. Decode only for publish-time validation. Preserve atomic rename-to-trash behavior and the missing-document race check.

11. **Static export buffers the complete library and rereads every output file. Medium.**

   [static-export.ts:95](../packages/cli/src/static-export.ts#L95) stores all generated pages and original documents in a Map of Buffers, then writes the map and rereads every file. Its memory requirement grows with the entire library. Local publish at [backend.ts:251](../packages/cli/src/backend.ts#L251) also rereads and compares bytes it just wrote, and only then validates generated metadata.

   Fix: validate generated metadata before writing. Build a snapshot directly in its private staging directory, retaining only file descriptors and hashes for the manifest. Process document bytes incrementally. Preserve deterministic ordering, ownership checks, staged replacement, and rollback. Put the meaningful integrity verification at the saved-snapshot deployment boundary described in finding 6. Remove routine byte-for-byte write-back checks unless a concrete fault model requires them; they do not establish power-loss durability.

12. **Bounded file reading is implemented twice. Medium.**

   [publish-input.ts:42](../packages/cli/src/publish-input.ts#L42) and [cloudflare-pages.ts:550](../packages/cli/src/cloudflare-pages.ts#L550) duplicate open/stat/chunk/count/limit/close logic.

   Fix: share one bounded regular-file reader with a byte limit and useful caller error context. Retain the extra-byte check because a file can grow while being read. Keep extension validation and UTF-8 decoding in the publish-input module. Do not replace this with an unbounded `readFile()` after a one-time size check.

13. **The shared package adds build coupling without a second product consumer. Medium.**

   [shared/package.json](../packages/shared/package.json) contains internal contracts and validation used only by the CLI. Its 521-line index mixes domain types, metadata validation, HTML parsing, and script policy. The workspace dependency is declared at the repository root, while the importing CLI package does not declare it. Correct build order is manually encoded in the root script.

   Fix: move this code into focused CLI document and HTML-validation modules and remove the internal package/build step. Keep the distributable executable contract. If a separate package is deliberately retained for an actual consumer, declare the dependency in the CLI and split implementation out of the package entry point. Simplify `DocumentType` to string if arbitrary labels remain the contract, and return metadata directly instead of the one-field `PublishResult` envelope.

14. **CLI parsing and orchestration are mixed together and parsing is duplicated. Medium.**

   [index.ts:349](../packages/cli/src/index.ts#L349) validates the same argument list repeatedly to read individual booleans. Three separate loops implement string flags and `--key=value` syntax. Viewer subcommands do not reject trailing arguments consistently. Interactive confirmation code is repeated for delete and revoke.

   Fix: use Node's argument parser with a small option definition per command. Validate required positionals and leftover arguments consistently. Keep parsing separate from command execution, and share one explicit terminal-confirmation helper. Retain straightforward dispatch; a command framework or plugin registry is unnecessary.

15. **Viewer health and saved process identity can disagree. Medium.**

   [viewer-server.ts:236](../packages/cli/src/viewer-server.ts#L236) treats any successful JSON response as `ok`, even when required health fields are absent. Status reports `stopped` for an unrelated server returning 404, while startup reports a port conflict. [viewer-server.ts:272](../packages/cli/src/viewer-server.ts#L272) checks only integer-ness of saved PID and port. Stop trusts that PID after checking home/port identity, without tying the process record to the current server process.

   Fix: parse health into explicit unavailable, foreign/incompatible, and matching-viewer results. Reuse that interpretation across ensure/status/stop. Validate positive PID and valid port ranges, write process records atomically, and match a per-process identity from health with the record before signaling it. Add lifecycle tests for stale records and foreign listeners.

16. **Browser code is an unchecked string, and local/static search already differs. Medium.**

   [viewer-assets.ts:3](../packages/cli/src/viewer-assets.ts#L3) embeds more than 100 lines of JavaScript in a TypeScript string, so the compiler cannot check its DOM operations. [viewer-render.ts:17](../packages/cli/src/viewer-render.ts#L17) searches each metadata field separately, while browser search uses concatenated text. Query trimming and maximum length also differ. Browser clear-search repeats logic already in its `commit()` function.

   Fix: author the browser script as checked source and bundle it into the existing executable asset. Use the same field-matching and query-normalization rules in both modes. Reuse the existing commit function for clearing. Keep stylesheet delivery simple; splitting CSS into a file is useful for tooling only if the asset build already supports it.

17. **A small set of wrappers and duplicated representations can be deleted. Low.**

   [index.ts:115](../packages/cli/src/index.ts#L115) wraps a constant in `formatUsage()`. [viewer-assets.ts:544](../packages/cli/src/viewer-assets.ts#L544) recomputes static CSP strings through functions. [viewer-render.ts:179](../packages/cli/src/viewer-render.ts#L179) has an exact escape-function alias. [viewer-server.ts:376](../packages/cli/src/viewer-server.ts#L376) implements a delay already available from Node's promise timers. [viewer.ts](../packages/cli/src/viewer.ts) re-exports unrelated server, render, and asset modules, so the static exporter imports server exports through the same barrel. Snapshot references carry both a capability and an exactly derived inbox path, then validate their equality.

   Fix: use constants for usage/CSP, one clearly named HTML escaper for the current text and quoted-attribute contexts, promise timers, and direct imports. Derive inbox paths inside the owning module rather than accepting both values. Reduce needless exports. Keep wrappers that enforce locks, private permissions, atomic writes, or credential redaction; those functions earn their place.

18. **Documentation and release checks have drifted from the implementation. Medium.**

   [site/index.html:504](../site/index.html#L504) says external assets and inline handlers are rejected, but the validator warns and continues. The architecture/ADR/threat model describe remote ownership-marker verification that the adapter does not implement. README claims theme behavior is exercised, although the suite only searches script text. [verify.yml](../.github/workflows/verify.yml) checks only Node 24 on Ubuntu despite the published Node 20 minimum and Windows-specific implementation. The Windows invocation is unit-tested, but later integration assertions unconditionally expect `npx`.

   Fix: update policy and ownership wording to match the chosen behavior, and describe only checks that actually run. Test the minimum supported Node runtime and make platform-dependent assertions platform-aware. Use a Windows job for the existing Windows support claim. Apply consistent workflow action pinning. Remove unexplained historical comments such as `ponytail` while editing the affected code, without deleting useful constraints.

## Implementation order

1. Repair test completion, remove misleading assertions, isolate tests, and establish a trustworthy baseline.
2. Repair saved-state parsing, operation types, deployment integrity, provider output parsing, and viewer process identity.
3. Simplify storage reads and export memory use; share bounded reading; replace the handwritten HTML parser with preserved regression coverage.
4. Simplify package boundaries, CLI parsing, browser source, search, and the small wrappers. Update documentation and release verification together with the behavior they describe.

Validate each stage with relevant tests, then run the full source and package gate. Preserve the local on-disk schema and command output unless a compatibility change is explicitly intended. Do not combine this work with a visual redesign or a new application framework.

## GitHub implementation tracking

- Finding 1: [#19](https://github.com/deveshsangwan/html-inbox/issues/19) The test gate can pass without running most of the CLI checks
- Finding 2: [#20](https://github.com/deveshsangwan/html-inbox/issues/20) The CLI test suite is one long, dependent scenario with incomplete cleanup
- Finding 3: [#21](https://github.com/deveshsangwan/html-inbox/issues/21) Several tests assert implementation details or fail to prove their stated behavior
- Finding 4: [#22](https://github.com/deveshsangwan/html-inbox/issues/22) JSON validation claims stronger types than it establishes
- Finding 5: [#23](https://github.com/deveshsangwan/html-inbox/issues/23) The remote-operation model permits impossible combinations
- Finding 6: [#24](https://github.com/deveshsangwan/html-inbox/issues/24) The snapshot digest is recorded but not checked against deployment input
- Finding 7: [#25](https://github.com/deveshsangwan/html-inbox/issues/25) The pinned Wrangler adapter guesses at many JSON shapes and silently treats unknown output as an empty result
- Finding 8: [#26](https://github.com/deveshsangwan/html-inbox/issues/26) HTML policy code owns a handwritten partial HTML parser. High maintenance cost
- Finding 9: [#27](https://github.com/deveshsangwan/html-inbox/issues/27) Storage repeats record-reading logic and identifies errors by prose
- Finding 10: [#28](https://github.com/deveshsangwan/html-inbox/issues/28) Metadata-only operations load complete HTML documents
- Finding 11: [#29](https://github.com/deveshsangwan/html-inbox/issues/29) Static export buffers the complete library and rereads every output file
- Finding 12: [#30](https://github.com/deveshsangwan/html-inbox/issues/30) Bounded file reading is implemented twice
- Finding 13: [#31](https://github.com/deveshsangwan/html-inbox/issues/31) The shared package adds build coupling without a second product consumer
- Finding 14: [#32](https://github.com/deveshsangwan/html-inbox/issues/32) CLI parsing and orchestration are mixed together and parsing is duplicated
- Finding 15: [#33](https://github.com/deveshsangwan/html-inbox/issues/33) Viewer health and saved process identity can disagree
- Finding 16: [#34](https://github.com/deveshsangwan/html-inbox/issues/34) Browser code is an unchecked string, and local/static search already differs
- Finding 17: [#35](https://github.com/deveshsangwan/html-inbox/issues/35) A small set of wrappers and duplicated representations can be deleted
- Finding 18: [#36](https://github.com/deveshsangwan/html-inbox/issues/36) Documentation and release checks have drifted from the implementation
