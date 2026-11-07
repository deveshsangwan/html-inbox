# Source-only stack on reviewed shared viewer lifecycle

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Root authorized this dependency integration after publishing the isolated
one-record smoke evidence. No integrated runtime qualification is claimed.

Pre-integration evidence pin: `04eeb14668396ee59d244567e582ac1e022f4517`.
A normal conflict-free merge produced `4c25ea8ee4a96d766e979c9319c2424748005636`
with that first parent and exact reviewed PR120 head
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad` as second parent. Draft PR122 now
targets `t3/shared-viewer-lifecycle-repair`; b249 is its immediate parent.
Original common-parent comparisons retain610 and their historical pins.

The changed paths of PR120 and96 did not overlap. Every96 production,
probe/harness, test and prior evidence file was preserved by the merge.
Shared parent files match b249; no duplicate Windows workaround was added.
PR120/114 ownership, refs, sources and generated outputs were not changed.
This closes a structurally unjoined fixture path identified by root/93. It
does not prove which native Windows handle caused the historical EPERM or
that every such failure is eliminated.

## Compiled artifacts are stale

No install/build/typecheck/test/runtime/browser/benchmark ran during this
integration. The199 compiled JS files and old release bundle remain unchanged
on disk, with their old qualified hashes. They are **stale for this new
combination** because inherited viewer source changed. Do not qualify or
measure this merged source using those bytes. The parent checkout is
`/home/agent/.t3/worktrees/html-inbox/t3-26d1cd47` at exact b249; no permission
to mutate its qualified outputs is implied.

Earlier fc858 correctness and084/0575 smoke evidence retain their old
source/executable/610-parent identities. They do not validate this merge.
New-head normal CI, combined local correctness, release/package behavior,
actual-parent measurements and both fresh same-pin reviews remain pending.

## Concrete next qualification request, not a grant

After root schedules a new local slot, propose exact Node24.19.0 typecheck and
build of the integrated candidate only, then exact Node20.20.2 and24.19.0 each
run the following six commands on the same new compiled bytes:

```sh
/absolute/exact/node --test scripts/bench/managed-read-contract.cjs
/absolute/exact/node --test packages/cli/dist/managed-view-regressions.test.js
/absolute/exact/node --test packages/cli/dist/managed-view-retention-check.js
/absolute/exact/node --test packages/cli/dist/static-export.test.js packages/cli/dist/local-document-source.test.js
/absolute/exact/node --test --test-name-pattern='^export fetched-origin guard rejects (imported|origin-only) return through (view|fallback)$' packages/cli/dist/sync-reader-compatibility.test.js
/absolute/exact/node --test packages/cli/dist/viewer-owned-lifecycle.test.js scripts/viewer-fixture-browser.test.mjs
```

This is14 commands plus two exact-version preflights, sequential, with a
900-second application budget and separate120-second cleanup allowance;
individual typecheck/build120s, wrapper90s, other checks120s. Last command
contains inherited owned-close3 and fixture8 controls. Its browserType is a
stub, but it opens real ephemeral reader/control HTTP listeners; request
explicit scope for their owned shutdown/port/root checks. No actual browser,
worker, full suite, parent build, bundle, high-count work or measurement is
requested in that phase. Stop first mismatch; preserve outputs, provenance
and adopted-child cleanup; release before packaging. Await root's explicit
scope rather than starting from this document or green CI.

Before any later complete-export measurement, a separate narrow source
change is needed: the current unchanged runner enforces `PARENT=610c931`.
It cannot currently accept b249 as the isolated comparison parent. Propose an
explicit full-SHA expected-parent argument, checked against the clean actual
baseline checkout, retaining610 for historical reproduction. Do not silently
replace the old baseline or bypass its identity check. Root must authorize
that harness change and its smoke scope before execution. Actual-parent
build/bundle mutation, seven-pair1/100 runtime matrices, package/integration
qualification and independent reviews remain separate later gates.
