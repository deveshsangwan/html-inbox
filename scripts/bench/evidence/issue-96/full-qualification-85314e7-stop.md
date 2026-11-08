# Full qualification stopped after pack at85314e7

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Root accepted the explicit release and bounded pack-artifact reuse described
below. The full qualification attempt remains **stopped**, npm-pack remains
**incomplete** in its original receipt, and all21 subsequent invocations are
UNRUN. No application suite, browser, listener, worker or pinned0.5 fallback ran.
There was no retry, cache restoration, oracle/controller change or resume.

## Exact scope and process results

Grant `root-96-full-85314e7-20261108-r1` launched once at clean candidate
`85314e7fd8dd356750c874c770d78fa3f6ba1304` versus actual parent
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. Approved root controller SHA256
`b85d7d350c44da898753749006655a5f81c38268d4163b85f4202e61c11c4dc7`
and manifest `7f84219f8814aa46401ffff9de485a186d4b76cacbe873cbf5418499aa0f91ec`
were copied as the exact five files into the fresh private0700 bound directory.
The adjacent outer command/tool receipts and original stdout/stderr are retained.
The exact launch argv was:

```sh
/usr/bin/python3 /home/agent/.t3/worktrees/html-inbox/perf-96-snapshot/artifacts/issue-96/full-qualification-freeze-attempt1/execute.py --expected-head 85314e7fd8dd356750c874c770d78fa3f6ba1304 --grant root-96-full-85314e7-20261108-r1
```

| Invocation | Process exit | Qualification state |
| --- | ---: | --- |
| Absolute Node20.20.2 `--version`,15s cap | 0 | Completed, exact version matched |
| Absolute Node24.19.0 `--version`,15s cap | 0 | Completed, exact version matched |
| Exact Node24 normal npm pack/prepack,180s cap | 0 | Postflight failed; original command incomplete |
| Remaining10 Node20 gates,10 Node24 gates,Python discovery | Not started | All21 UNRUN |

Pack used the exact Node24 installation's npm-cli.js, cwd packages/cli, and the
manifest's absolute package-artifact output directory. All argv/env/cwd/limits,
raw outputs, the complete unrun list and failure traceback remain in the archive.
Controller exit was1. Its first error and final provenance error both report
`Fresh dependency identity changed: .../node_modules/.pnpm`.
No normal suite failure or exported-document defect was observed in this phase.

## Input-policy classification

Root independently compared all6804 dependency inventory entries. Only these
four existing ncc cached-data files differ; all6800 others match, with no added
or removed entry. Cache mode/UID/device/inode remained unchanged.

| Path under ncc/dist/ncc | Bytes before | Bytes after |
| --- | ---: | ---: |
| cli.js.cache | 199696 | 199704 |
| index.js.cache | 3945152 | 3945192 |
| loaders/relocate-loader.js.cache | 637424 | 637416 |
| loaders/shebang-loader.js.cache | 2752 | 2752 |

The complete pinned wrappers explicitly install an exit handler that writes
basename+'.cache' using script.createCachedData(). Their unchanged sources and
hashes are retained in root's audit. This fits the observed tool behavior and
identifies an error in the immutable-dependency policy, accepted by root as a
source-review omission. There is no original native-writer trace or product
failure claim, and no blanket *.cache exemption is approved.

The immutable manifest retains exact BEFORE sizes/hashes. Raw before-cache bytes
were not separately copied and have not been recovered. All four AFTER byte
files were copied and checked against the first post-stop delta, and are in the
archive. Current parent cache paths are different inodes from candidate paths;
no independent pre-run parent cache inode/hash inventory is claimed. Parent
compiled/bundle outputs and all recorded tool/runtime identities match.

## Bounded pack reuse accepted by root

Root separately accepted these facts for artifact reuse only:

- All400 candidate generated files and bundle reproduce measured bytes; all392
  parent generated files and bundle remain unchanged.
- The lossless measured backup contains exactly401 matching files, including the
  bundle. Both independent audits checked its complete file set and hashes.
- Normal pack tarball is260070bytes, SHA256
  `b7e5a45f0204cba70e41cdbaf640218f47ef6e20453609326b2000b84422bfdb`.
  Its only four members are LICENSE, README.md, package.json and bundle/index.js
  under package/, each matching the pinned source/product bytes.
- All335 reusable inputs and28 flattened runtime/tool identity files match.
  Candidate/parent HEAD, ref and staged entries match before/after; raw index
  bytes also match in the additive read-only comparison.

The controller's final Git-after capture was not reached because verify_inputs
failed first. The additive comparison is labeled separately and does not rewrite
that missing controller field. No installed consumer, full runtime behavior or
normal package-smoke acceptance follows from a byte-identical tarball.
Successful prior44ef typecheck/79a build and scoped ecffd/caf/c491 evidence keep
their original pins and missing historical transitive-declaration hash limit.
No speedup, full qualification or historical CI-cause claim is added here.

Root audit SHA256 is
`8ba0db805a17086b6aeb76a2de8de365026a604b918a6e0d50e48be8052d89a6`,
local record
`/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue96-full-85314e7-stop-root-audit.json`.
Its exact bytes are archived. Original controller receipt SHA256 remains
`8528f8ed4fbd0a73ae105284343461ef8121b956b47a0b94b6fcdaf264f1b622`,
with result stopped/incomplete npm-pack. Bounded reuse does not change that result.

## Cleanup, release and capture limits

Controller recorded16.716163s application time and1.846990s failure cleanup,
with both deadline flags true. One adopted child exit0 was reaped while its
command was pending; no controller signal was sent. Those facts do not qualify
generic race/interruption behavior or unexercised paths.

Independent owner postflight, then root's separate rescan, found all7 saved
PID/start identities and3 groups absent. Inferred controller PID2935618 was also
absent. No extra bind probe, signal, delete, chmod or restore was performed.
Both completed version work roots are absent. Three exact private directories
remain intentionally retained and untouched, with no housekeeping grant:

- full-qualification-freeze-attempt1/npm-pack-work
- full-qualification-freeze-attempt1/measured-artifacts
- full-qualification-freeze-attempt1/package-artifact

The first adjacent outer /proc match missed the controller because it had
already exited; its metadata guard raised AssertionError: []. Tool session79199,
actual command and logs are retained, but outer PID/start/group/session were not
captured. PID alone is inferred from recorded child PPIDs; no start identity is
recovered or invented. The guard failure and shell's later successful tail
commands remain distinct. This limits outer admission/cleanup proof.

EXPLICIT RELEASE was2026-11-08T19:43:45.857115Z before packaging. Independent
native PID/group postflight has its own recorded monotonic bound before the
controller's fixed cleanup deadline. UTC finish-to-release98.644313s plus
recorded cleanup1.846990s gives the retained conservative100.491303s accounting;
it is not a reconstructed perfect outer monotonic timer. Root accepted release
with those limits. No application/runtime work occurred after release.

## Lossless selected evidence

[Archive](full-qualification-85314e7-stop.tar.gz),4110955bytes, SHA256
`5c6ed1e4bc0a9734980e8ee2bcd0545ca57855a9ef5c30c67c4e7c80f583bf27`.
All438 file members were compared to disk;437 evidence entries have complete
size/hash records. Member prefix is exactly full-qualification-85314e7-stop/,
with attempt/, launch/ and evidence-hashes.json beneath it. No flat-layout
assumption is needed.

This preserves the exact executed source/manifest/root diff/preparation/index,
original receipt and logs,401 measured backup files, tarball, after-cache bytes,
full before/after inventory delta, wrapper/root audit, launch-gap records and
additive Git/output/cleanup/release audits. The retained npm-pack-work contents
are excluded from publication; its550-entry metadata inventory is included.
No managed ledger/key/token contents are captured. Unsupported internal exports
remain unobserved; no application export operation ran.

A post-release packaging selection guard initially mistook the safe metadata
filename retained-npm-pack-work-inventory.json for the excluded raw tree. It
stopped before index/archive creation; exact path-prefix selection corrected
that packaging check only. The note is retained. A preliminary pre-root-audit
archive/index is also preserved locally; final publication adds root's audit and
source proof without changing original records.

Root has prepared a separate SOURCE-ONLY tests continuation route. It is not a
runtime grant or automatic resume. Full normal qualification, shared Windows/
LENGTH/navigation/finalization observations, original610 combined-stack criterion
and two fresh same-pin reviews remain open. Draft/watch/backlinks remain; no
parent mutation, merge or release.
