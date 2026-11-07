# Pending actual-parent identity and smoke request

Related to [#96](https://github.com/deveshsangwan/html-inbox/issues/96) and
[draft PR122](https://github.com/deveshsangwan/html-inbox/pull/122).
This amends the future actual-parent phase only. The fourteen-command combined
correctness request remains separately queued and ungranted. No new Python
unit test, application, build or smoke has run for the parent parameter.

## Source-only identity boundary

`--expected-baseline-commit` accepts exactly40 hexadecimal characters for
managed-read, normalizes case and checks the actual clean baseline HEAD.
The full610 SHA remains the documented legacy default; every new integrated
command explicitly supplies full b249. Invalid, shortened and ref-name input
rejects, as does flag use on unrelated workloads. There is no parent inference
or silent constant replacement. Existing build-file/fingerprint and clean
checkout checks remain. Environment metadata records resolved expected SHA
beside actual baseline/candidate build identities.

Six pure ParentIdentityTests cover fullSHA boundary, default/explicit and
unrelated workloads, clean matching build fingerprints, mismatch including
implicit610 against b249, dirty refusal and missing build files. They use
mocked Git reads and synthetic filesystem files, not a new runner or accepted
managed state. Workload, timing/process ownership, corrected I/O parser and
combined correctness wrappers remain unchanged. Source checks only until a
new explicit grant.

## Separate requested execution

After root accepts source and schedules a slot, request eight sequential
commands plus exact absolute20.20.2/24.19.0 version/binary preflight. Use the
Node24.19.0/corepack-pnpm prefix already recorded in prior requests.

1. In `scripts/bench`, `python3 -m unittest test_managed_read.ParentIdentityTests`, maximum30s, selects the six new identity controls.
2. Candidate exact24 `typecheck`, maximum120s.
3. Candidate exact24 `build`, maximum120s.
4. Candidate exact24 `--filter html-inbox bundle`, maximum180s.
5. Exact b249 parent `build`, maximum120s.
6. Exact b249 parent `--filter html-inbox bundle`, maximum180s.
7. Exact20 actual-parent smoke below, maximum180s.
8. Exact24 equivalent smoke in another fresh directory, maximum180s.

The parent is the existing app-owned checkout
`/home/agent/.t3/worktrees/html-inbox/t3-26d1cd47` at exact
`b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. Its source/ref must remain clean
and fixed. This request seeks explicit authority for generated build/bundle
mutation there; no such authority exists now. Root must coordinate with the
PR120 owner and preserve its qualified output identities before any mutation.
No checkout creation or install is requested. Any reuse of a later accepted
candidate build must be explicitly scoped with matching source/build hashes.

```sh
python3 scripts/bench/run.py managed-read \
  --baseline-repo /home/agent/.t3/worktrees/html-inbox/t3-26d1cd47 \
  --expected-baseline-commit b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad \
  --node /absolute/exact/runtime/node \
  --counts 1 --sizes 10240 --samples 1 --timeout 30 \
  --out /absolute/fresh/actual-b249-evidence
```

Budget900s aggregate application plus separate120s cleanup, with both15s
version preflights and each command capped to its remaining absolute deadline.
Each smoke retains eighteen owned sequential children. No full suite, actual browser, application listener, worker, high count or
sustained timing is requested; bundle work is limited to the two listed
commands. Stop first
failure; preserve original output/errors and classify before any correction.
No fix/retry or assumption replacement is authorized by this request.

Record exact expected/actual baseline SHA and clean status, before/after
source/runtime/compiled/bundle hashes and command exits. Independently audit
raw seven-field I/O snapshots/maps/deltas, fixture-derived native opens/body
bounds and complete exports/manifests/nonce distinctions. Derived ledger size
is only cross-profile consistency; cite live stat assertions, never a retained
stat that was not captured. Reap/drain all owned/adopted processes, verify
ports/roots if any, release explicitly before packaging. Preserve every older
artifact and its original610 comparison. This one-record phase supplies no
practical-gain claim or permission for a measurement matrix/reviewer launch.
