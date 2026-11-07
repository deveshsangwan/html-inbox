# Pending narrow I/O requalification

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
This is a source-only request. No new test or smoke has run.

The [partial 76 receipt](ci-harness-76b20f5.md) and immutable archive preserve
all original exit statuses, outputs, cleanup and invalid counter profiles.
Root independently accepted those bounded facts and the slot release, while
withholding full harness qualification. The additive `final-audit.json`
recovers both Node 24 Unicode diagnostic roots and verifies all six roots;
it leaves the historical four-root receipt untouched.

## Narrow source repair

The CJS preload now captures exact raw `/proc/self/io` text before/after the
counted process. It performs no regex or missing-to-zero conversion. Existing
native FileHandle counting is unchanged. The existing Python companion owns
a pure parser seam and completes the profile with parsed before/after values
and deltas for all seven named fields, including `syscw`. It rejects missing,
malformed, duplicate or unknown fields and decreasing per-process counters.
Valid physical-I/O zeroes remain allowed. Raw/parsed data are saved before
native-activity assertions, so a failed assertion retains the evidence.

Four focused Python controls cover known nonzero values/deltas and exact raw
text, legitimate zero physical I/O, every missing named field, malformed
integers/duplicates/unknown/non-text/decreasing fields. Existing comparator
controls and workload command structure are unchanged. No application code,
CI wrapper, frozen probe, process runner, runtime, dependency or format policy
changes. Current candidate199/parent195 compiled files and both bundles remain
byte-identical to the partial run; no rebuild is requested.

## Requested execution after an explicit grant

Use the clean frozen source pin in the handoff. Verify hashes of the already
recorded absolute Node20.20.2 and24.19.0 binaries,199/195 compiled maps and both
bundles before and after; preserve source/ref cleanliness in both checkouts.
Runtime paths and parent610 checkout are those in the earlier frozen request.
No mutation of parent generated output is needed.

Request three sequential commands, plus exact-version preflight if root wants
it repeated:

1. In `scripts/bench`, `python3 -m unittest test_managed_read.ProcIoTests`, maximum30 seconds. This selects only the four new pure parser controls.
2. In candidate checkout, the existing managed-read smoke below on exact Node20, maximum180 seconds.
3. The identical smoke on exact Node24 with a separate fresh output directory, maximum180 seconds.

```sh
python3 scripts/bench/run.py managed-read \
  --baseline-repo /home/agent/.t3/worktrees/html-inbox/perf-89-bench \
  --node /absolute/exact/runtime/node \
  --counts 1 --sizes 10240 --samples 1 --timeout 30 \
  --out /absolute/fresh/requalification-directory
```

Use a 420-second aggregate application budget and separate bounded120-second
cleanup allowance. Each smoke still launches18 sequential owned children.
No install/build/typecheck/bundle, repeated44/GC suite, application listener,
worker, browser, full suite, 100-record timing or sustained measurement.
Own/drain/reap all groups/adopted children before removing outer temporary
roots. Preserve first failures and raw output; no fix-and-retry or assertion
relaxation. Release explicitly before evidence packaging and root inspection.

The read-only evidence audit must split each saved raw snapshot independently,
check the complete integer field set, recompute every before/after delta and
compare it with both saved parsed maps and delta dictionaries. It must not
import the tested parser or compute from saved delta values. Check `rchar`
against actual ledger+body bytes and `syscr` against admitted file reads;
require no positive physical-I/O minimum. Preserve all sixteen complete export
trees and manifest/snapshot hashes, exact CLI nonce/path distinctions, native
counts, command/PID/group/root cleanup and original invalid76 records.
One pair remains harness qualification only, with no benefit claim. No
reviewers or sustained measurements follow without another root instruction.
