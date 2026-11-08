# Tests-only qualification stopped at the first shard

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Root accepted explicit release, **not qualification**. The first Node20 shard
was interrupted at its300-second command cap. It remains incomplete;20 later
invocations are UNRUN. No retry, increased bound, controller/oracle change,
additional diagnostic, new reviewer or continuation followed.

## Exact execution and first boundary

Grant `root-96-full-tests-3be43b8-20261108-r1` ran once at clean
`3be43b8a0b4904468b926ade13f5eb4c93d83214`, actual parent
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. Exact five root-prepared files,
controller97f58a302a82e21b8d8ee699e0dc2dc99e5f36a7f9d9c291df4c0e1c9209fe5a
and manifest5ee20b560323ea4a8a184d18a48ccbdba26ed9079fffc0e10c5b0d740c421ec5,
were copied into the private0700 bound tests directory. No source bytes changed.
The adjacent command/tool receipts retain the exact one-time launch:

```sh
/usr/bin/python3 /home/agent/.t3/worktrees/html-inbox/perf-96-snapshot/artifacts/issue-96/full-qualification-tests-attempt1/execute.py --expected-head 3be43b8a0b4904468b926ade13f5eb4c93d83214 --grant root-96-full-tests-3be43b8-20261108-r1
```

| Command | Result |
| --- | --- |
| Absolute Node20.20.2 `--version`,15s cap | Exit0, completed |
| Absolute Node24.19.0 `--version`,15s cap | Exit0, completed |
| Absolute Node20.20.2 `scripts/run-unit-tests.mjs --test-shard=1/2`,300s cap | Interrupted, exit-15, incomplete |
| Remaining9 Node20 gates,all10 Node24 gates,Python discovery |20 invocations UNRUN |

The first outer boundary was the300s **unit-command deadline**, reached about
0.014183s before stop handling. The4500s application allowance was not exhausted.
Original error is `RuntimeError('Absolute deadline exhausted; retain roots')`;
controller exit1. Application elapsed312.456620s and cleanup4.281860s, with both
aggregate deadline flags true. Those flags do not turn the interrupted shard
into a pass. Exact argv/env/cwds/caps and the complete incomplete/unrun lists
remain in the immutable receipt.

## Partial TAP evidence, not a shard result

Full stdout is198745bytes, SHA256
`908fe3aec9ba24654f4c689d766a207b570acdea936659a7ad40b29198384178`.
Stderr is empty. It contains490 top-level ok records, **including one explicit
SKIP**, and81 nested ok records. No not-ok record and no final TAP plan/summary
were emitted. These records overlap: do not sum them or call this a shard pass.
Unemitted/buffered outcomes are not known from this partial stream.

The explicit skip is the old-viewer baseline CLI control, which requires an
untouched compiled b843e126 CLI via HTML_INBOX_BASELINE_CLI. That executable was
not supplied by this normal manifest. The last completed top-level record490 is
`blocked authentication retries survive worker polling and only explicit retry resumes delivery`.
No hang, product cause, host-load cause or deadline-sufficiency conclusion follows.

Failure cleanup issued five identity-checked SIGTERMs. All exact PID/start pairs
are retained in the controller/root audit. There were83 recorded adopted exits:
77 code0, one code1, one code-9 and four code-15. Raw adopted statuses are not
independent test verdicts; no success/failure or intentionality is invented from
them. There is no generic interruption or race guarantee from this execution.

## Ownership, retained evidence and release

Controller self identity2948445/start88652590,PPID2946943,PGID/session2948445
and exact argv were recorded before its first child and independently matched
live through /proc. This is new evidence for this attempt; it does not recover
the prior853 missing outer sample. Tool session35036 exited1.

Owner's bounded independent scan and root's separate rescan found all1257 saved
PID/start identities,84 groups and the exact controller identity absent. Root
reported no unreadable /proc stat in its scan. Existing suite rebind diagnostics
remain distinct from that process evidence; no additional bind, signal, delete
or restore was performed by owner postflight or root.

EXPLICIT RELEASE was2026-11-08T20:17:05.659722Z, monotonic886927.316728893,
31.163880s before the fixed cleanup deadline886958.480608814. Both completed
version work roots are absent. The new retained work root has exactly these TMP
entries: html-inbox-worker-fault-3LRTGI and html-inbox-sync-tls-Ii8I7i.
All four retained top-level directories remain untouched, with no housekeeping
grant:

- Historical full-qualification-freeze-attempt1/npm-pack-work
- Historical full-qualification-freeze-attempt1/measured-artifacts
- Historical full-qualification-freeze-attempt1/package-artifact
- Fresh full-qualification-tests-attempt1/node20-unit-1-work

Their private ledger/key/token contents are excluded from publication. No generic
complete-fixture removal claim is made. No application/runtime ran after release.

## Unchanged artifacts and additive root audit

Root verified335 reusable inputs,400 candidate/392 parent generated sets and both
bundles,28 identity files,all6804 dependency entries and401 measured backups.
All match. Original stopped pack receipt/tarball and the three historical retained
directory identities match. Git HEAD/ref/staged semantics and raw index bytes
match before/after. Controller final input verification completed without an
input/cache mismatch. The already accepted package was reused read-only; no
pack/build/typecheck was repeated and no installed-package gate was reached.

Original tests receipt SHA256 is
`8399b60a8d568b2e4a922ed22300ffd557dbf11d82ca8dbcea1dcceff92877a2`.
Root audit SHA256 is
`57d0e5398bbaf3a45b576558834f147ab1765a57d394a5e2b0e104c666131022`,
local record
`/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue96-full-tests-3be43b8-stop-root-audit.json`.
Exact additive audit bytes are archived. Neither original receipt nor earlier
pack stop8528f8ed was rewritten. Bounded pack reuse and prior scoped correctness/
c491 benefit retain their original accepted limits; this attempt adds no full
qualification or performance result. Historical typecheck declaration-hash,
100ms sampling and unsupported internal-output limits remain.

## Separate hosted CI and public archive

Historical853 Verify42515764448 was independently verified green. At tested3be,
[Verify42518040028,attempt1](https://github.com/deveshsangwan/html-inbox/actions/runs/42518040028)
also had all16 terminal workflow jobs successful. The watcher notification said
2 checks; the actual read-only snapshot had18 rollup entries, including skipped
Macroscope and successful CodeRabbit. No cause for the count difference is
inferred. Hosted CI does not execute this ignored controller, replace this local
interrupted result, or resolve shared historical causes/original610 criteria.
New documentation heads require their own CI accounting.

[Lossless selected evidence](full-tests-3be43b8-stop.tar.gz),983845bytes, SHA256
`2658a57c4f31e83d7a3c589c8b123d47e049e5545ccec6dd20d31920642994d6`.
All30 file members were compared to disk;29 records have full evidence hashes.
Prefix is full-tests-3be43b8-stop/, with attempt/,launch/,hosted-ci/ and the
hash index. It retains exact executed source/manifest/preparation/diff/index,
original logs/receipt, self/external identity, all interventions/adopted outcomes,
partial classification, cleanup/release/root audits and hosted snapshots.
No retained work tree is archived. The earlier401-file backup/tarball evidence
remains in immutable archive5c6ed1e4bc0a9734980e8ee2bcd0545ca57855a9ef5c30c67c4e7c80f583bf27.

Full qualification, shared Windows/LENGTH/navigation/finalization observations,
original610 combined-stack criterion and two fresh same-pin reviews remain open.
No new task, source/controller edit, retry or continuation is authorized. Existing
draft/watch/backlinks persist; no parent mutation, merge or release.
