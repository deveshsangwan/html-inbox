# Review-fix requalification

Implementation base610c931b7b22920cce59cf03e49c0de15ebaf2a2. Original tested4b43e006 and first reviewed6546267 remain preserved. First-round6546267 is REQUEST CHANGES. Complete first-round reviews are archived in review-round1-sol.txt and review-round1-sonnet.txt; dispositions are in review-round1-disposition.md.

This round tests candidate5829aa42741a16c1099efb71f41dab1d94660529 in the same existing isolated repair checkout. The eventual qualification commit changes evidence only. PR117 remains f290211f440f65c11c877dd5baf50b88cda2d969, untouched. No runner/rename or runtime/storage/wire/permission policy changes were made. No benchmark or speedup claim.

## Actual red, not an inferred reproduction

The bounded red command used reviewed6546267 PRODUCTION files plus the new5829 tests, not a claim of an untouched reviewed tree:

`fnm exec --using=24.19.0 node --test --test-name-pattern='failed viewer startup|preserves browser and root-removal' scripts/viewer-fixture-browser.test.mjs`

Exit1, three failures, in reviewed-red.log.gz. Startup case failed with Missing expected rejection at the teardown assertion: old fixture removed its root and resolved, instead of retaining/reporting failed-startup evidence. Both local/static cases failed the AggregateError identity assertion because the root-removal error replaced the browser-close error. These are the intended failure-handling assertions. The old run did not independently expose the negative reporting-order assertion; that green contract is checked on the candidate and no stronger red claim is made. No native Windows EPERM was reproduced or attributed.

To reproduce, copy red-and-restore.py from this evidence commit outside the checkout, select the preserved5829 candidate in the existing repair worktree, create artifacts/shared-viewer-lifecycle/round2, and invoke the copied script from that worktree. It requires a clean candidate HEAD and re-creates its logs/manifests.

red-and-restore.py retained the exact5829 HEAD, overlaid ONLY viewer-server.ts and browser-fixtures.mjs from6546267, built and hashed that production/test overlay, ran the bounded expected-red cases, then unconditionally restored candidate production and rebuilt dist in an outer finally. Its subprocess groups were created and retained by that runner and reaped/killed only within that owned session. The reviewed-overlay compiled viewer-server.js hash matches the first-round tested4b43/6546 identity. reviewed-overlay-identity.json.gz records all395 source/compiled hashes; candidate-restored-identity.json.gz records the restored tested candidate. There was no branch/worktree creation or PR117 edit.

## Green and expected checks

All following commands exited0, sequentially. Exact records are in commands.json and verification.json; raw logs are losslessly compressed with hashes in ../log-archives.json.

- Restored candidate build: `fnm exec --using=24.19.0 pnpm build`.
- `fnm exec --using=24.19.0 pnpm typecheck`.
- `fnm exec --using=24.19.0 node --test scripts/viewer-fixture-browser.test.mjs packages/cli/dist/viewer-owned-lifecycle.test.js`: 11 passed, failure-green24.log.gz. Includes startup+rollback cause identities, retained root, reporting settlement/no late reporting, local/static browser+rm cause aggregation, repeated exact same rejected close promise, journal record and both listener rebinds.
- On BOTH exact20.20.2 and24.19.0: `fnm exec --using=<version> node --test packages/cli/dist/viewer-owned-lifecycle.test.js packages/cli/dist/viewer-mutation-shutdown.test.js packages/cli/dist/viewer-shutdown.test.js packages/cli/dist/viewer-startup-races.test.js packages/cli/dist/viewer-tailscale-lifecycle.test.js scripts/viewer-fixture-browser.test.mjs scripts/document-deletion-browser.test.mjs`: 63 passed each, focused-node20/24.log.gz.
- `fnm exec --using=24.19.0 pnpm verify`: source1327 passed/3 skipped, harness15 passed, skills146 passed/2 skipped, full browser81 passed/1 skipped, site9 passed, installed-package foreground/detached/Tailscale/publish/delete/shutdown checks passed. verify-node24.log.gz preserves full output.
- `git diff --check 610c931 -- packages/cli/src scripts`: exit0.

final-identity.json.gz verifies all395 source/compiled files still match the restored tested5829 candidate AFTER normal verify/prepack rebuilt dist. Lockfile unchanged. Original identity.txt retains runtime/compiler information, including compiler CLI output Version7.1.0-dev from the pinned tsc-rs package. cleanup.json records no remaining exact-worktree cwd/argv processes, with inspection ancestors excluded. Failure-case fixture evidence was asserted before explicit test-owner removal. This is not an independent census of every host process or directory.

## Preservation and limits

Original parent-red output, all first-round review text, and all eight diagnostic-manifest originals remain byte-identical. log-archives.json records every original log path and SHA256, its gzip path and independently checked decompressed SHA256. Local raw originals remain in round2/raw-originals; original commits also retain raw paths. Use `gzip -dc <archive.log.gz>` to recover exact bytes. No assertion text, trailing reporter whitespace or historical failure was trimmed to get a clean diff. The large raw logs are no longer source-text noise.

Remaining custom document-isolation-browser fixture migration is an explicitly deferred caller follow-up outside createBrowserFixture. No claim is made that every custom fixture or all native EPERM cases are repaired. Original first-round naming/log-label suggestions remain cosmetic dispositions. Native Windows/macOS final-head CI and two fresh focused independent round2 reviews are still required; Linux checks do not replace them.

Published6546267 had separate Windows command-runner descendant-marker and macOS sync foreground-ticket deadline failures. Raw logs, exact identities, metadata and the rejected403/accepted201 Windows retry responses are retained by the owner under perf-93-startup/artifacts/93/pr120-ci. Only one actual unchanged Windows retry was authorized; no macOS retry or sync/runner source change was included. These failures are not called pre-existing from unchanged source or prior successful runs. Normal CI on the eventual qualified fix head is the relevant final gate.
