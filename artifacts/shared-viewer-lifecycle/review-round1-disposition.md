# Round 1 disposition, awaiting requalification

Base610c931; reviewed6546267; tested4b43e006. Complete original Sol High and claudeAgent Sonnet5.5 Medium outputs are archived beside this document. Original6546267 is REQUEST CHANGES, not review-passed. No runtime checks of these follow-up changes have run yet; #95 owns local execution. Published PR120 remains6546267 and draft. PR117 remains unchanged.

Sol Medium1 accepted: track failed viewer startup in the fixture and retain its root instead of assuming no returned lifecycle handle means cleanup is complete. startViewerLifecycle awaits memoized failure journaling before throwing the original startup+rollback AggregateError. Added a gated startup/configuration+rollback failure test checking both cause identities, reporting completion before rejection, root retention and no late reporting. Requires red/green run on reviewed source/new source.
Sol Medium2 accepted: collect root removal errors and aggregate them with prior browser-close error, keeping both original identities and root path. Added deterministic local/static failure-injection cases. Requires red/green qualification.

Sonnet1 Low, custom document-isolation fixture raw-close pattern: acknowledged as a separate remaining caller outside createBrowserFixture. No migration is included in this bounded review fix; root can route that follow-up. PR must not imply every custom fixture or native EPERM cause is repaired.
Sonnet2 Low, memo-layer names/owner-close log label: deferred cosmetic refactor. Existing shutdown reason vocabulary and observers remain stable; the three promises have distinct roles, actual close, observed failure journaling, and returned owner completion. No correctness finding was reported.
Sonnet3 Low root-rm masking browser error: accepted and fixed with Sol Medium2, pending tests.
Sonnet4 Low single setImmediate gate observation: retained as bounded scheduler-turn observation backed by exact-parent red plus post-release green assertions. No claim of proving absence for infinite time or a native Windows actor. No sleep or probabilistic EPERM assertion added.
Sonnet5 Low rejected-repeat coverage: accepted. Added direct owned-close test asserting identical returned promise before/after rejection, exact original error identity, one removal attempt, failure record, and both listeners rebound. Pending qualification.
Sonnet6 Suggestion bulky raw evidence: accepted for evidence-packaging cleanup after qualification. Preserve original raw bytes or compressed reproducible equivalent and immutable first-round pin; do not delete red failures or claim missing logs passed. No need to rerun tests merely to compress logs.

No command-runner/rename changes are authorized or included. The remote Windows descendant-marker failure is separately coordinated. Final CI/root audit and fresh focused independent round2 reviews are still required after a newly granted requalification slot is released.
