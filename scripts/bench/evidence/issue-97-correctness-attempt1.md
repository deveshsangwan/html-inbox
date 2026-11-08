# Issue 97 first correctness attempt

Related to [issue 97](https://github.com/deveshsangwan/html-inbox/issues/97) and [draft PR 124](https://github.com/deveshsangwan/html-inbox/pull/124).

The root narrowed the initial requested slot to candidate correctness only under grant `root-97-correctness-a3e087c-20261108-r1`. The clean head was `a3e087c3fc8bafdf3d604a1737bc9677ee5a0d2a`, with immediate parent `b24927abf4cae14c9bbf1753ff6ea2cfb7a945ad`. No baseline overlay or benchmark was permitted or performed.

The execution adapter failed before launching the first Node version command. Its environment override supplied `XDG_CACHE_HOME` to the reused execution function, which already supplied that keyword. Python rejected the duplicate with `TypeError: dict() got multiple values for keyword argument 'XDG_CACHE_HOME'`. This is an adapter mistake, not an application test failure, runtime incompatibility, outer deadline expiry or validation verdict. The adapter process exited 1. There was no child command exit code or TAP output.

The grant required stopping at the first failure, with no fix or retry in the attempt. All eight planned commands remain unrun: both runtime version/hash preflights, frozen install, typecheck, build, bundle, Node 20 tests and Node 24 tests. Source and lock hashes remained unchanged. No compiled or bundle output was created. No production, test, fixture or assertion changed. No next attempt ran.

The original receipt and adapter remain unchanged. Independent cleanup confirmed that the adapter PID was absent and that no subprocess was created or observed. The empty `fixture-node20-version` directory and its owned parent were inventoried and removed before the original absolute final deadline. The original receipt's `command_roots_removed: false` records the state before this cleanup; only the additive `independent-cleanup.json` supplies the later successful removal evidence. The empty tooling-cache root remains. No listener, application/helper child or library fixture was launched. LOCAL was explicitly released to root immediately after cleanup.

The [compact JSON receipt](issue-97-correctness-attempt1.json) records the exact pins, first error, all unrun commands, deadlines, artifact hashes and independent cleanup. The raw artifact directory is `/home/agent/programming/html-inbox/artifacts/performance-issues-2026-11-07/issue97-correctness-a3e087c-attempt1`. Its original files are `executed-manifest.json`, `execute-granted-sequence.py`, `reused-execution.py`, `receipt.json` and additive `independent-cleanup.json`. The manifest retains exact argv/cwd/environment selections. The public compact receipt preserves the failure and cleanup even without access to that machine.

Separately, the ordinary [GitHub Actions run](https://github.com/deveshsangwan/html-inbox/actions/runs/42526569454) passed its source, browser, skills and Verify jobs at source head a3e087c. These remote CI results do not complete the granted exact-version local run or provide performance evidence.

The PR stays draft. Local correctness, repeated exact Node 20/24 performance measurements with spread, and later fresh same-pin Sol High and Sonnet 5.5 Medium reviews remain open. Both reviewers must receive the full rubric and each return functionality, code-quality and validation verdicts. Neither review has launched. No merge or release is authorized.
