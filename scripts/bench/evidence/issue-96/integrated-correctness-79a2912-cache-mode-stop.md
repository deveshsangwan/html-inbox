# Continuation stopped at tool-cache directory permissions

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
Grant `root-96-integrated-correctness-79a-20261108-r2` ran at clean
`79a2912864044f310401f2ee8a0a6c1bdd390997`, parent
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`.

The exact approved controller was copied into a fresh ignored directory,
hash-verified and launched once with the granted full-head/grant arguments.
Its SHA256 remains
`9ac9f9e0e8e3d19ceb1443099a810d6ff11232e55aa320a5d88f6c1954cd3232`.
The original stopped attempt, prepared controller and seven unexecuted helper
controls remain unchanged.

Both exact absolute Node20.20.2/24.19.0 versions and hashes passed. The exact
Node24.19.0/Corepack pnpm11.7.0 candidate `build` exited0. The first postflight
then rejected `node-compile-cache` directory mode0775 under the command's
private0700 TMPDIR. Its version subdirectory was also0775. Both were owned by
uid/gid1001; all nine files were0600 with one link. The cache held2244412bytes.
The immutable44ef stop metadata already showed directory mode0775, which was
missed when preparing the stricter guard. This is a controller expectation
mismatch, not a demonstrated compiler or application defect. No guard,
environment, runtime/cache behavior, production code or test was changed to
continue. There was no retry.

**All twelve runtime checks remain unrun**, including baseline18, actual-view44,
GC retention, existing export/source, selected origin and inherited listener
lifecycle controls on both runtimes. No output-capture observer ran. There are
no new export, lifetime, GC, listener-close or performance results. No install,
typecheck repeat, helper test, bundle, parent mutation, actual browser, worker,
full suite or measurement ran.

Root permitted reuse of the successful44ef typecheck based on retained tracked
inputs and recorded tools. The original limitation remains: installed transitive
declaration/tool-library hashes were not separately retained at that typecheck,
so their complete historical byte equality cannot be reconstructed.

All542 tracked hashes, runtime and eight tool hashes stayed unchanged. The
successful build replaced old398 compiled files with400 files, including200JS.
These fresh candidate bytes are **not runtime-qualified**. Their JS-map aggregate
is `457cc15a7e0b66fbab4d7a127d8efd3e12ca94443816655d01b1c25377e61c4d`;
the full path/size/hash-map aggregate is
`caf0bebd71a784a521077005f08a9a9d6afe7e17047e6e531ef2c2e681f4f64d`.
Aggregates use sorted compact Python JSON. Full old/new maps are retained in the
raw receipt. The unchanged old bundle remains stale for the combination.

Eight observed PID/start identities and three groups were absent after joining,
with no adopted children or signals. The four version HOME/TMPDIR roots were
removed normally. Build HOME/TMPDIR and exact cache bytes remain **preserved in
place** for root inspection because the guard rejected them. No deletion bypass
or all-roots-clean claim was made. Additive inspection records their modes,
ownership, contents and hashes without modifying the original receipt.

The local slot was explicitly RELEASED at2026-11-08T17:06:24.706291Z after owned
heavy work settled and before packaging. Application wall time to controller
stop was2.892911seconds; automated cleanup0.006785seconds. Sampling every20ms
can miss shorter-lived processes. This does not establish generic interruption
or OS-close handling.

Root independently confirmed the original0775 cache-directory modes and
accepted this as an overly strict tooling guard. Root is preparing a minimal
tests-only continuation using the immutable successful-build receipt/map,
without another build or cache exception. No controller was prepared by this
owner after the stop. Both retained roots await exact archive/copy verification
and a separate cleanup instruction. No new execution grant is implied.

Root must inspect the retained roots and cache-mode policy before any correction,
cleanup or continuation. No further controller implementation or application
execution is authorized by this receipt. The separate actual-b249 workload phase,
practical measurements, full package qualification and both fresh reviews remain
open. Green hosted79a CI remains separate, pinned evidence. New docs-only heads
need their own CI accounting.

## Lossless file evidence

[Raw archive](integrated-correctness-79a2912-cache-mode-stop.tar.gz), 847486bytes,
SHA256 `1066be540f73d0054e97bf288f079ee83cc776807a89506aeed17a47f83bb557`. All22 members were compared byte-for-byte
to disk; the hash manifest covers the other21 files. Includes original
controller, receipt, commands/logs, full maps, additive inspection/release and
all nine tooling-cache files. No managed ledgers or keys were captured.
Original retained directories and files were not deleted or modified.
