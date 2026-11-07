# Release lines and activation gates

Part of #88. This prerequisite keeps the current CLI at 0.6.1 with Node >=20. Version 0.7.0 and the `node20` npm tag are not published by this change. No modern candidate exists yet. There is no performance claim for this policy work; it enables compatible performance work and isolated modern storage qualification under #87.

## Branches and publication

The orchestrator approved this layout on 7 November 2026:

- The prerequisite PR targets `main`. Root cuts `release/0.7` from the reviewed shared base.
- Compatible performance changes target `release/0.7`. The 0.7.x package keeps Node >=20 and current storage, wire, validation, permissions and durability behavior.
- Forward-port shared fixes to `main` with separate tests against its implementation. Storage divergence makes an untested cherry-pick unsafe.
- A separate reviewed activation PR under #88 changes `main` to 1.0.0, Node >=24.19.0, modern CI and pre-storage runtime rejection together, after driver/minimum qualification. Modern production changes wait for activation; isolated design/prototype PRs may proceed earlier.

Before 1.0, stable releases retain npm `latest`. After 1.0, `latest` belongs to the modern line and `node20` belongs to the latest 0.7.x release from `release/0.7`. The manual publish workflow requires an explicit tag, reads the current stable npm version, and rejects wrong branch/engine/tag combinations before installing or packing. It blocks all modern publication until activation implements the remaining gates. Registry lookup failure stops publication. npm tags and Git release tags change only during a separately authorized release, never during policy implementation. No automatic merge or publication is authorized here.

## Runtime and library selection

Today, use the existing published 0.6.1 CLI on Node >=20. Both skills retain the independently tested published 0.5.0 npm fallback and their current installed-version rules. The fallback has no managed-sync commands. A missing feature requires an authorized compatible upgrade, preserving the selected library and saved exposure.

Once 0.7 is published, Node 20 users will install `html-inbox@0.7`, or `html-inbox@node20` after that tag is explicitly published. These are future installation choices, not currently tested fallback pins. Maintaining a Node 20 compatible package does not promise upstream Node 20 maintenance.

The compatibility line supports today's ordinary libraries and the existing managed ownership schema 2 / ledger schema 1 contract with capable coordinated writers and workers. The 0.5.0 fallback cannot operate enrolled managed libraries. The modern library format and driver remain undecided. Before any 1.x library exists, implement and test runtime-and-format-aware resolution in both skills: Node 20 must stop on a modern-only library, and modern users must never silently fall back to a legacy writer for that library. The current shell resolver does not implement that future format gate. Do not use it on a modern prototype library. Stop and report an unsupported format rather than try another writer, library or pin.

Before switching versions or formats, stop viewers, hubs and independent sync workers through their original executable, retaining the same inbox binding. Verify shutdown, including independent workers, before taking a consistent backup. Preserve the old executable until shutdown is proven. Keep a quiescent pre-upgrade backup; an older executable is not a rollback writer for an upgraded library. Restore offline under the documented [migration and rollback rules](named-inboxes.md#upgrade-to-060). Existing storage and private-control checks remain mandatory.

## Completed prerequisite and remaining gates

This PR supplies branch/tag publication guards, lightweight policy tests, verification on `release/0.7` pushes, and consistent staged guidance. Source tests still cover Node 20/24; the workspace build runtime remains separate from the package engine. It does not certify package behavior or speed on a new runtime.

Before #88 can close:

- Qualify 0.7.x packages on Node 20 and a modern runtime, preserving existing behavior.
- Select the modern driver and qualify the actual Node >=24.19.0 minimum. Raising that minimum later requires a deliberate release-policy change, never a silent patch.
- Build a modern candidate with an entry point that rejects unsupported runtimes before imports or initialization can touch storage. An `engines` declaration alone is insufficient.
- Test the exact modern archive at the minimum and Node 26, including unsupported-runtime rejection with an untouched library. Add the modern CI matrix and publish artifact gates together with activation.
- Implement runtime/format resolution and adversarial tests in both skills, including incompatible installed CLIs, modern stores, fallback refusal and shutdown/backup handling. Promote only published, independently tested fallback pins.
- Update package engines, CI, package smoke checks, READMEs, website and both skills together at activation. Perform releases and tag changes only after explicit release authorization.

Heavy runtime/package matrices and benchmarks require a slot from the #87 orchestrator. #89 owns the first slot. This prerequisite uses source inspection and lightweight policy/skill/site checks only.
