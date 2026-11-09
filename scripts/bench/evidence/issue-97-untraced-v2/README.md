# Issue97 accepted immediate-parent measurements and startup diagnostic

Related to [issue97](https://github.com/deveshsangwan/html-inbox/issues/97) and [draft PR124](https://github.com/deveshsangwan/html-inbox/pull/124).

Root accepts the scoped immediate-b249 practical benefit: source-peer noop reconciliation of100 documents replaces53,632,600 logical ledger bytes in203 commits on the parent, versus792,609 bytes in3 commits on the candidate. Each of three pairs on each exact runtime saved52,839,991 bytes,98.5221507%. This is the preselected primary metric, not physical drive traffic. Unchanged-reconciliation and repair latency improve in every pair. Initial-transfer and empty-library latency gains are unproven. This does not clear original610, CI, reviews or readiness.

Measured HEAD is `e0171fc548d449eb1de1e76975155fb699449d79`, production `a3e087c3fc8bafdf3d604a1737bc9677ee5a0d2a`, actual immediate parent `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. This later publication adds only the approved fatal-test observation and evidence/plan. No measured production, harness, tool-code or393 output byte changes.

## Original data and reproduction

[raw-and-provenance.tar.gz](raw-and-provenance.tar.gz), SHA256 `25fd47c59c891baf542258bc38051b61af9e61124412f242d245a6124776ebbb`, contains152 named members. [members.json](members.json) lists sizes, hashes, original paths and explicit extracts. All64 original runner files from16 invocations are byte-identical copies: environment.json, samples.jsonl, summary.json and cleanup.json per invocation. All42 original command logs, exact adapter/unchanged engine/manifest, source maps, argv/environment/cwd/caps, launcher/native-exit/identity/release evidence, selected controller receipt fields, full owner/root metric data and reviewed diagnostic source are retained. Every archive member was read back and byte-compared. No managed ledger, body, key, credential/token, retained fixture/backup body, NCC cache body or raw-index binary is published. Raw-index hashes and semantic maps are metadata only.

[All1504 operation metric pairs](owner-paired-samples.csv), [all422 repeated metric spreads](owner-paired-spreads.csv), [all70 outer metric pairs](outer-paired-samples.json) and [all20 outer metric spreads](outer-paired-spreads.json) include regressions and undefined relative changes when parent is zero. Full1,179,064-byte root review is in the archive, SHA256 `2448a99ed5f9ba68d23055495e3d83be6f6fd142ebcbd310b9862fba28cde69e`. [Root result decision](issue97-untraced-e0171fc-v2-root-result-decision.json), SHA256 `2ad86634b06b9c47afb27e3340663f31b4c51d391677c99aa42ce34737e9d0ca`, records the accepted scope and every cost/limit. Original receipt SHA256 is `d6a5a01c275aa5ccd0b56173e1412459dba4b712004944e11fee81b48cfa3856`. Public raw copies supplement the private originals rather than replace them.

All21 commands exited0;16 invocations produced28 outer samples/156 operation rows, with no incomplete/unrun step. Two exact runtime versions preceded a worktree-only fullb249 source overlay, one exact24/Corepack pnpm11.7.0 build and bundle, and the preselected16 sequential invocations. Parent/candidate orders were20 P-C/C-P/P-C and24 C-P/P-C/C-P, then129 controls20 P-C and24 C-P. Each existing untraced runner used `sync --counts 0,100 --sizes 10240 --samples 1 --timeout 360 --node <exact absolute runtime> --out <unique role/runtime/pair target>`;129 used only `--counts 129`. Both roles used the same approved current harness. Raw parent runner HEAD remains e017 with dirty source; verified full source/generated maps bind it to actualb249. Raw root review production_source:null is preserved, with explicit source binding in source/provenance.json.

## Observations

All values below are min/median/max across three within-runtime pairs. Paired changes are candidate minus its matched parent, not differences between unpaired medians. Negative changes reduce time. No p95/significance or pooled runtime result is inferred.

| Exact Node | Operation | Parent ms | Candidate ms | Paired change ms | Paired change % |
| --- | --- | ---: | ---: | ---: | ---: |
| 20.20.2 | peer/initial/100 | 127,782.623/131,930.734/132,082.048 | 129,111.293/129,346.934/130,805.383 | -2,970.755/-1,125.351/1,564.312 | -2.249/-0.853/1.224 |
| 20.20.2 | peer/noop/100 | 14,258.392/14,721.628/14,779.670 | 2,804.041/2,871.137/2,910.820 | -11,975.629/-11,850.491/-11,347.572 | -81.028/-80.497/-79.585 |
| 20.20.2 | peer/repair/100 | 16,013.043/16,260.489/16,734.732 | 4,047.541/4,185.397/4,323.779 | -12,410.952/-12,075.092/-11,965.502 | -74.723/-74.260/-74.163 |
| 20.20.2 | peer/noop/0 | 232.019/234.057/239.731 | 233.431/235.986/237.466 | -6.299/1.929/5.447 | -2.628/0.824/2.348 |
| 24.19.0 | peer/initial/100 | 74,884.102/74,915.408/74,971.649 | 73,965.814/75,037.995/75,359.170 | -949.594/66.346/475.068 | -1.268/0.088/0.634 |
| 24.19.0 | peer/noop/100 | 8,414.762/8,634.327/8,667.689 | 1,705.519/1,710.463/1,737.947 | -6,929.742/-6,928.808/-6,704.299 | -80.247/-79.949/-79.673 |
| 24.19.0 | peer/repair/100 | 9,421.161/9,454.010/9,584.449 | 2,574.680/2,618.179/2,643.086 | -6,941.363/-6,879.330/-6,802.982 | -72.766/-72.423/-72.210 |
| 24.19.0 | peer/noop/0 | 207.505/208.438/272.327 | 206.304/209.292/214.383 | -63.035/-2.133/6.878 | -23.147/-1.024/3.314 |

Source noop100 logical bytes and commit counts have identical min/median/max in all three pairs for each runtime. Initial100 source replacement bytes also drop41,054,022 to20,797,909 and commits203 to103, but initial latency/CPU have mixed paired signs and overlapping ranges. The entire sync100 command includes setup and all passes; its paired wall changes span -14.978% to -12.509% on20 and -13.916% to -13.062% on24. Those supporting measurements are separate from the primary noop metric. Every CPU, RSS, I/O, source, receiver and wire sample is in the raw files and complete pair/spread tables.

All36 counterpart peer controls match wire/body-work/transfer counts. Initial/noop/repair transfer100/0/1, with exact identity/metadata/signature/fingerprint/receipt and receipt-backed confirmed-obligation comparisons. Noop has zero HTML open/read/hash/transfer work. One missing body repairs exactly once. Both roles on both exact runtimes also complete129-document controls with unchanged assertions. Existing128-page path plus noop6 requests versus4 at100 supports actual two-page behavior. There is no per-page event trace,129 repeated spread or129 gain claim.

Costs and limitations from the accepted root decision:

- Bundle1276123 ->1277958 bytes: +1835 (+0.1437949163207622%). Receiver noop100 replacement231542 ->231545 (+3) with one commit each; source count0 noop3828 ->3834 (+6) with two commits each. These byte changes are retained observations, not explained by an asserted metadata cause.
- Initial100 source replacement41054022 ->20797909 and203 ->103 commits, but initial latency and CPU changes have mixed paired signs/overlapping ranges; no repeatable initial-transfer speedup accepted.
- Empty-library noop latency changes have mixed signs/overlapping ranges; no empty-library speedup or universal nonregression guarantee. All managed samples, regressions and spreads retained.
- Post-operation RSS and whole-command peak RSS are separate measurements. No causal memory explanation or extrapolation to all workloads. All current noop100/repair100 RSS pairs and outer100 peaks were lower; small samples are descriptive.
- Logical replacement lengths are observer-derived, not physical device writes. Raw process IO counters are separate scope including existing proc reads; no zero-IO/cold-cache/device-write inference.
- Three pairs per role/runtime, deliberately reversed order imbalance across runtimes, same host/fresh isolated fixtures/uncontrolled warm filesystem caches. No pooled driver effect, significance/p95, gain-based stopping, higher-count or issue1.9GB estimate verification.
- Original120s failures and traced gain-ineligible histories remain immutable. Only unrelated protocol diagnostic testJS is stale against e017 TS; this run does not qualify current test source.
- Hosted e017 Node24.22.2 startup-reader nlink guard failure remains RED and unexplained. Verify is aggregate-only;50 selected24.19.0 passes and454-test same-driver shard pass are nonreproduction, not baseline/flake/exoneration/green.

## Ownership and operational limits

Once-set4200s application plus120s cleanup/fixed4320s governed the run; individual caps exceeding the aggregate could only produce partial/unrun, never extend it. Native adapter/tool exit0 was captured through terminal joining, in2563.795s from the outer budget start. Commands inherited explicit0002, recorded preexec and independently live. Child request/pass/lease/lock bounds and assertions stayed unchanged.

Candidate source/393 outputs were saved first. Every owned role prefix was fully inventoried, supported regular bytes/metadata preserved before replacement, immutable backups checked, and all owned processes joined before switches/restoration. Unsupported types would be retained and stop restoration; this normal run does not qualify unused adversarial/interrupt branches. Full544 tracked/593 owned/393 current+saved candidate maps and semantic staged mode/object/path/tree were independently restored. Raw-index snapshots differ as bytes; there is no raw-index write/restoration/equality/cause claim.

Exactly four of the seven enumerated NCC DATA cache values changed in the single authorized parent-bundle window. Their original and resulting bytes/identities remain private and hashed; only metadata/maps are published. Other1777 tool pins/runtime bytes stayed strict, with resulting full cache tree frozen for subsequent steps. Code/cache.js files never received a cache exception. No general ignore/rebaseline or cache restore occurred.

Initial owner safety parsing treated groups_seen objects as integers and stopped before process scan/release. That metadata-only error and first raw-index observation remain intact; corrected schema parsing completed the independent audit with no application/adapter retry. All103 saved PID/start identities and51 groups, including launcher/outer groups, were absent, and owned command/runner roots were absent. Release was55.554s before the shorter cleanup deadline. [Original root audit](issue97-untraced-e0171fc-v2-release-root-audit.json) first covered102 identities/49groups; [addendum](issue97-untraced-e0171fc-v2-release-root-audit-addendum.json) supplies complete103/51 and frozen NCC metadata. Sampled identities are not exhaustive short-lived-process coverage.

Root data-only reader corrections for zero-parent relative labels, null spread representation, keyed control ordering and a Python scope error are retained in the full result decision. They changed no original arithmetic/data or application outcome. No raw failure, earlier stop or unrun step was rewritten.

## New startup observation and current CI

The [exact approved test-only source review](issue97-startup-lstat-diagnostic-e017-root-review.json) pins fatal-test TS `1fa6bb902f7d32ac0edf4f15ebd6f3286ae34fff92a1324e85d5718fc629ad99`, patch `a35fe4d074364b0ab4296b7c78a379922060bc976500bf284d816bb43c519fbb`, mode0664. The nonasync lstat pass-through returns the same original promise/value/error with identical this/arguments. Only existing parent fixture-ledger bigint lookups during original startup get observation handlers. It retains the last8 completion-order bounded numeric metadata records, restores the complete descriptor, and emits one failure-only tagged <=4096-byte line. No extra stat/await/retry/poll/timer, production instrumentation, guard/deadline or assertion change is added.

Root ran ONE pinned native tsc-rs0.7 noEmit compiler-only check over197 copied source files with the proposed target and exact baseconfig. Nativeexit0, empty stdout/stderr, result SHA256 `1be0392459b5e9751d2e3c998fb2ca60c2448a8e96703c00faf475a7e5d10d3b`. Exact compiler argv/result are archived. It imported/executed no application/test and changed no tracked/generated bytes. It is not runtime qualification of observer/failure/restoration/cap branches. Added promise handlers change scheduling and rejection-handledness. Last8 completions have no internal callsite labels and cannot alone identify native cause. Catch protects synchronous write exceptions, not guaranteed asynchronous stream errors/flush. Absent output is inconclusive.

The [e017 hosted24.22.2 failure](https://github.com/deveshsangwan/html-inbox/actions/runs/42542109540/job/128919107872) remains unresolved:453pass/1fail of454, detached fatal-log case throws the managed-ledger one-link guard during post-readiness startup, before intentional symlink/fatal assertions. Verify is aggregate-only;14 leaf jobs passed. Root's50 selected and454-test default-concurrency24.19.0 passes are nonreproduction, not flake/base/exoneration or CI-green evidence. New diagnostic-source NORMAL CI is pending on this publication, not a retry of e017. The old887 header failure remains separate and unresolved.

Source-only publication retains all393 measured R2 outputs. Protocol diagnostic testJS was already stale; fatal diagnostic testJS is now also stale versus its new TS, other391 production/helper/bundle bytes unchanged. New normal CI rebuilds the tests. No further local compiler/build/test/application, reviewer or CI retry ran for publication.

## Remaining gates and preserved history

Original610 combined comparison, current/final normal CI diagnosis/disposition and two fresh same-pin full-rubric SolHigh/Sonnet5.5Medium reviews remain open. Each reviewer returns functionality, code-quality and validation verdicts. No review has launched and draft stays draft. [Current plan](../issue-97-plan.md) describes the minimal source-only610 assessment; it grants no execution. No readiness/merge/release conversion.

[R2 correctness](../issue-97-correctness.md), [original untraced120 stop](../issue-97-peer-feasibility.md), [traced120/parent360/candidate360 history](../issue-97-diagnostics-v1/README.md), and [identity V1 mode stop/V2 serial pass](../issue-97-identity-diagnostic-v1/README.md) remain immutable historical reports. Earlier pending/ungranted language describes those frozen publications; this report and root decision supply the later scoped acceptance. Traced timings remain gain-ineligible, original1.9GB remains a source-derived estimate, and no610 execution is backfilled.
