# Still-unrun integrated correctness request

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[PR122](https://github.com/deveshsangwan/html-inbox/pull/122). **Not a grant.**
The [original partial receipt](integrated-correctness-44ef6c0-stop.md) and raw
archive remain immutable. Root accepted its explicit release and tooling-cache
classification. Tested44ef typecheck retains exit0 credit. Its docs-only
publication is `1d54cd9e6b6bff03172c0080da88ca05256f1314`.

## Source-only controller correction

Prepared a new ignored controller at
`artifacts/issue-96/integrated-correctness-continuation-prepared/execute.py`.
The original controller was not edited. The [source archive](integrated-correctness-continuation-source.tar.gz)
contains this controller, a complete diff from the original, seven prepared
helper controls, an input-invariance receipt and file hashes. Only AST syntax
and read-only hash/diff checks ran. Neither controller nor helper controls ran.

Controller SHA256:
`9ac9f9e0e8e3d19ceb1443099a810d6ff11232e55aa320a5d88f6c1954cd3232`.
Diff SHA256:
`27dd138130e0c2af70d171ac14b0c68869a466f9ca234d14b6ef53255ea1b288`.
The27561byte archive has five byte-verified members and SHA256
`a648f223f0eb390e1162fbeae958f683e0b5804c8e1f3b7315d48d0f6f46e6bb`.

Only the exact private `node-compile-cache` entry from the exact pinned
`[Node24, Corepack pnpm.js, build]` command receives tooling classification.
Every other command, including application tests, still rejects any temp
residue. An unrelated entry beside a recognized cache also stops the run.
Classification requires owned groups and children joined first. Cache roots
must be real directories; every descendant must have the current owner, no
group/world write bits, regular-file/directory type and no file hardlinks.
Symlinks and other types reject. The controller saves file metadata and exact
SHA256 values before removing the cache, then requires an empty TMPDIR before
removing the isolated roots. No cache/runtime environment behavior changed.

Prepared controls cover empty temp, exact-build inventory without deletion,
wrong command, unrelated residue, root type/symlink, descendant links/modes and
join-before-classification. They remain unexecuted and are not extra commands
in this application request. No production, probe, wrapper, admission, GC,
close/read or export oracle changed.

The controller requires an explicit full40-hex `--expected-head` from root's
next grant plus its `--grant` identifier. It refuses dirty/wrong source and
verifies exact b249 ancestry. It checks the immutable original receipt hash,
then refuses any change to its335 tracked non-documentation/evidence inputs,
including all tracked TypeScript, or eight recorded compiler/tool hashes.
The published source-preparation receipt proves those equalities now. Full
installed transitive declaration/tool-library hashes were not retained at the
earlier typecheck, so their historical byte equality cannot be reconstructed.
Root decides whether the retained input proof suffices to reuse typecheck;
this request neither reruns it nor silently claims that missing evidence.

## Exact requested scope

At the clean docs/evidence pin containing this request, immediate parent
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`, request **13 sequential commands
plus two version preflights**, with no automatic execution:

1. Exact Node20.20.2 and24.19.0 `--version`,15seconds each, binary hash checks.
2. Exact Node24.19.0 and its existing Corepack pnpm11.7.0 `build`,120seconds.
3. Exact Node20.20.2 followed by24.19.0, each the six commands below on the
   same newly built bytes.

```sh
ABSOLUTE_NODE --test scripts/bench/managed-read-contract.cjs
ABSOLUTE_NODE --test packages/cli/dist/managed-view-regressions.test.js
ABSOLUTE_NODE --test packages/cli/dist/managed-view-retention-check.js
ABSOLUTE_NODE --test packages/cli/dist/static-export.test.js packages/cli/dist/local-document-source.test.js
ABSOLUTE_NODE --test --test-name-pattern='^export fetched-origin guard rejects (imported|origin-only) return through (view|fallback)$' packages/cli/dist/sync-reader-compatibility.test.js
ABSOLUTE_NODE --test packages/cli/dist/viewer-owned-lifecycle.test.js scripts/viewer-fixture-browser.test.mjs
```

Absolute binaries remain
`/home/agent/.local/share/fnm/node-versions/v20.20.2/installation/bin/node` and
`/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/bin/node`.
Corepack entry is
`/home/agent/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/corepack/dist/pnpm.js`.
Wrappers have90second limits; the other test commands120seconds. Expected
case counts per runtime are baseline18, actual callback44 inside one wrapper,
GC1 inside one wrapper, containing18, selected origin4 and inherited lifecycle11.
Record runtime-specific name-filter skips separately.

The entire application phase has one absolute900second deadline, plus separate
fixed120second cleanup allowance. Each command must fit its full individual
scope in remaining time. Cap waits/reaps to remaining deadlines. Per-command
HOME/TMPDIR/catalog isolation, exact PID/start/group/descendant/adoption tracking,
joined-root removal, original logs and stop-first-failure policy stay intact.
Retain failures or roots if joining cannot finish; no retry or oracle relaxation.

Build once; preserve old-stale and new full compiled maps, compare after every
test, each runtime and finally. Retain runtime/compiler/source/lock/bundle
identities, commands/env/cwd/exits, all selected diagnostics and narrowly scoped
direct-test export captures. Existing wrappers sanitize child environments;
their inner byte assertions are executed but not externally copied by that
observer. No arbitrary filesystem interception is added.

Inherited lifecycle controls use a stub browser with real ephemeral owned
reader/control listeners. Keep their existing shutdown/port/root assertions
and intentional error/journal outcomes. No redundant post-run bind pass.
Explicitly release after owned work settles and before packaging.

No install, typecheck repeat, Python/helper tests, bundle, actual browser,
worker, full suite, parent checkout/output mutation, workload smoke, measurement,
reviewer or CI retry is requested. Bundle stays old/stale after build. The
actual-b249 phase and all practical-benefit/package/review gates remain separate.
