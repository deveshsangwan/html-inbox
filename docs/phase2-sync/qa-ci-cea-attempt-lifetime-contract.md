# Awaitable route-attempt shutdown

This gate authorizes the narrow watcher-lifetime correction established by the case203 diagnostic. One real source watcher created a canonical mutation lock after synchronous attempt close and during fixture removal. Settling that producer first preserved all original clock/custody assertions and successful cleanup. The historical combined-run actor remains unknown. This gate does not change case453's separate fixture ordering correction.

The complete read-only design and cancellation addendum are retained with this gate. The requirements below are authoritative. Preserve the existing watcher-error-to-public-abort classification. A stronger raw-error or fatal-worker policy is outside this change.

## Ownership and baseline

Production scope is limited to `sync-store.ts`, `sync-files.ts`, `sync-client.ts`, `sync-reconciliation.ts` and `sync-http-server.ts`. Existing-test scope is limited to the awaitable close mock in `sync-shutdown-ingestion.test.ts` and explicit direct-attempt lifetime in `sync-review-regressions.test.ts`. Preserve every assertion in those tests. Add `sync-attempt-lifetime.test.ts`; one test-only helper named `sync-attempt-lifetime-child.ts` or `sync-attempt-lifetime-fixtures.ts` is allowed if actual shared fixture ownership requires it. Do not add a production test export or fault environment variable.

Use all 167 parent sources from `/tmp/html-inbox-qa-history-amcemjlx/source-cea-pagination-integrated.sha256`, aggregate `b3fe50512a22f17215abe1dcb0dac403a7f428c58892b2c94ccf42f4b9bcd82b`. The five production baseline hashes are:

```text
45b2cbdaa7d7e6938789bfb8400aafa45621a7e2acd3ecdd9b8a7ccd82934063  sync-store.ts
28aec0025c935bf27116a5b646790654f263ce7a7336b3f3607fa5c7f0f62630  sync-files.ts
15512f302a6328bf343cf900cd5fb44996abb0203af4e77e90194d4901f3262c  sync-client.ts
71cfc27845cd81476e00a1457643dd9518b5ba8b87dddb6c0451c620917e01ab  sync-reconciliation.ts
eadf1c465312c71b87cb13562dde5ac16a16e22e570527d1d19f7b06c167ce5a  sync-http-server.ts
```

Write only in the app-owned isolated worktree, preserving and restoring all nonowned borrowed files. No worker, publication, clock-skew, ownership-worker, ledger/wire/runtime/lock schema, deadline, retry limit, credential or authorization changes. Parent owns documentation.

## Attempt close

Change the inline attempt contract to `{ signal: AbortSignal; close: () => Promise<void> }`. Preserve the real 50 ms unref interval and one-check limit. Retain the complete admitted check promise before its first asynchronous store operation. Guard closing state explicitly so an already-dispatched callback cannot admit new work after close.

First close synchronously stops admission and clears the interval. Capture the admitted promise and cache one drainer promise before private abort notification can reenter close. Concurrent and later calls return that exact same promise. Normal close cancels only a private watcher controller with a unique owned reason; it must not itself abort the public attempt signal.

Join the complete producer through directory checks, queue/acquisition, protected work, ownership release and descriptor cleanup. Keep this exact active registry entry and parent abort listener until settlement. Remove only that entry, preserving any newer live entries and current map container. Quiesce observes draining attempts; it is not a permanent admission fence. Existing persisted route revocation, pause semantics and caller-owned admission authority remain unchanged.

Ignore only rejection identical to the private normal-stop reason. Other watcher failures retain the current observed public-abort path, including compound failures containing the stop reason. Close joins that observed result; this does not newly surface raw watcher storage errors or guarantee uncertain namespace cleanup succeeded. Preserve this explicit visibility limit in the handoff. Never suppress an error by a broad `signal.aborted` catch, message matching or cause traversal.

## Cancellable waiting with real cleanup

Add only an optional fourth signal to `withStoreLock(directory, deadlineMs, operation, signal?)`. Thread it privately through the watcher's mutate call and `withProcessLock`. Existing unsignalled callers retain behavior. Check cancellation before and after watch-only directory inspection, during the existing same-process queue wait, after queue admission and before protected work.

Cancelling a queued entry must remove its listener/timer but preserve the chain behind the prior holder. A successor cannot bypass that holder. Once native ownership acquisition starts, await it and all actual cleanup; do not race it against cancellation and leave a future writer alive. Pass the signal into existing `acquireSyncOwnership`.

Place the post-acquisition cancellation check inside `finishLockOperation`, after obtaining ownership, so even that handoff race awaits actual release. Existing inode, exact-owner, no-replace link, fsync, descriptor, unknown-owner and reaper rules stay intact. Compound operation/cleanup errors keep every cause. No live lock stealing or force removal.

Normalize cancellation only in a private retry-wait helper whose try contains exactly the native `timers/promises` delay. At both managed and portable retry waits, a non-aggregate Error with `name === "AbortError"`, `code === "ABORT_ERR"`, an aborted signal and direct `cause === signal.reason` becomes that exact reason. Every other rejection remains the same object. This helper contains no filesystem, reclamation or acquisition work and cannot be reused as a broad error classifier.

Compatibility is explicit: existing signalled acquisition callers cancelled during retry waits now receive `signal.reason`, matching checkpoint cancellation, instead of Node's timer wrapper. Unsignalled calls and portable catalog registration remain unchanged. Do not add an opt-in flag or cross-module brand registry. A cleanup failure after normalized cancellation still produces the existing compound error; the watcher cannot mistake it for normal close.

## Owners and cancellation precedence

Await actual close in client request, reconciliation and HTTPS handler finalizers. Preserve client timer/listener cleanup and actual network-result semantics. Keep best-effort authenticated session completion before reconciliation close. After added close and the existing final snapshot/count awaits, normalize cancellation immediately before choosing the route result, observing both outer controller and attempt signal. Preserve durable receiver custody, receipts and existing request/pass deadlines; add no new request or mutation after the final check.

HTTP active-request decrement and handler removal must follow the attempt join, including failed cleanup handling. Preserve detached read-only pin handling, late-header prevention and its independently retained file handle. Do not turn attempt close into whole-store quiescence or attach detached pins to its watcher promise. Existing 1000 ms server-close and 600 ms quiesce tests remain unchanged. Cancellation must retire not-yet-acquired watcher work rather than waiting out a 10-second lock behind that pin. Already-entered native I/O can still outlast a bound; report the existing honest close/quiesce failure and retain authority rather than inventing success.

No caller may await a close from its own producer or while holding a lock that its producer needs. Existing three production finalizers are outside their protected mutation callbacks. Do not add lock-ownership detection infrastructure. An owner needing stop from a protected callback may initiate synchronous stop and await the cached promise after releasing its own work.

## Source preparation and verification

Source preparation is authorized now; runtime is HELD until the linked-cut fixture author is terminal and the parent explicitly releases it. No install, compiler, Node, probe or mutex admission while held. Add meaningful real-producer regressions before implementation. The existing recorded case203 red is a valid unchanged baseline; additionally retain an old-source comparison for a new close-lifetime regression where it compiles and exercises the same actual producer. Do not claim compile-only failure as a runtime red or alter production types solely to manufacture a baseline.

After release, use exact Node20.20.2 and Node24.21.0, an owned established subreaper, real waitpid receipts, isolated paths and the shared bounded mutex. Required regressions cover actual watcher release joining; pre-enqueue and genuine queue cancellation without bypassing an unrelated holder; stable/reentrant close identity and dispatched-callback admission; client/pass/HTTP owner lifetimes; cancellation during close and final snapshot; late-pin bounds with an actually queued watcher; expected fence/pause behavior; unknown/live/unsafe ownership; exact timer reason normalization, unrelated errors, cancellation plus real cleanup failure and acquired-before-close release.

Use real stores, native callbacks, handles and verified HTTPS. Controls must prove actual producer entry, one-shot holds and releases, real locks and cleanup. A missed hook or unexecuted assertion is untested. No fake stats, owners, custody, timeouts, receipts or positive test-body transformation. Preserve all original clock-skew tests byte-for-byte and validate their full suite, including real clock contexts and all expiry/identity/TLS negatives.

Run dedicated and affected clock, acquisition, transport, revocation, shutdown, ownership, worker-fault and finalization/publication suites on both runtimes. Parent combined checks and two fresh reviews follow. Do not run a broad full suite or expand outside owned files without parent coordination. Preserve all previous reports, failed audits and invalid helpers. Ordinary private pre-target tooling defects may be corrected with retained evidence; compiler, target, missed producer, admission or unsafe cleanup failures stop without a test retry or scope expansion.

Return full parent-relative and owned patches, exact command/exit/count/exclusion/log hashes, source pins, baseline and controlled evidence, compatibility/visibility limits, restored nonowned states, scoped process/listener/credential cleanup and released runtime. No commit, push, PR action, native/Fleet/physical job, merge, deployment or QA SHA release.
