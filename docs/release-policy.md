# Release lines and activation gates

The current CLI is 0.6.1 with Node >=20. The planned lines are 0.7.x for compatible improvements and 1.x for modern runtime and storage work. Version 0.7.0 and the `node20` npm tag remain pending; no modern candidate exists yet.

## Branches and publication

- Create `release/0.7` from the reviewed compatibility base on `main`.
- Compatible performance changes target `release/0.7`. The 0.7.x package keeps Node >=20 and current storage, wire, validation, permissions and durability behavior.
- Forward-port shared fixes to `main` with separate tests against its implementation. Storage divergence makes an untested cherry-pick unsafe.
- A separate reviewed activation PR changes `main` to 1.0.0, Node >=24.19.0, modern CI and pre-storage runtime rejection together, after driver/minimum qualification. Modern production changes wait for activation; isolated design/prototype PRs may proceed earlier.

Before 1.0, stable releases retain npm `latest`. After 1.0, `latest` belongs to the modern line and `node20` belongs to the latest 0.7.x release from `release/0.7`. The manual publish workflow requires an explicit tag, reads the current stable npm version, and rejects wrong branch/engine/tag combinations before installing or packing. It blocks all modern publication until activation implements the remaining gates. Registry lookup failure stops publication. npm tags and Git release tags change only during a separately authorized release, never during policy implementation. No automatic merge or publication is authorized here.

## Runtime and library selection

Today, use the existing published 0.6.1 CLI on Node >=20. Both skills retain the independently tested published 0.5.0 npm fallback and their current installed-version rules. The fallback has no managed-sync commands. A missing feature requires an authorized compatible upgrade, preserving the selected library and saved exposure.

Once 0.7 is published, Node 20 users will install `html-inbox@0.7`, or `html-inbox@node20` after that tag is explicitly published. These are future installation choices, not currently tested fallback pins. Maintaining a Node 20 compatible package does not promise upstream Node 20 maintenance.

The compatibility line supports today's ordinary libraries and the existing managed ownership schema 2 / ledger schema 1 contract with capable coordinated writers and workers. The 0.5.0 fallback cannot operate enrolled managed libraries. The modern library format and driver remain undecided. Before any 1.x library exists, implement and test runtime-and-format-aware resolution in both skills: Node 20 must stop on a modern-only library, and modern users must never silently fall back to a legacy writer for that library. The current shell resolver does not implement that future format gate. Do not use it on a modern prototype library. Stop and report an unsupported format rather than try another writer, library or pin.

Before switching versions or formats, stop viewers, hubs and independent sync workers through their original executable, retaining the same inbox binding. Verify shutdown, including independent workers, before taking a consistent backup. Preserve the old executable until shutdown is proven. Keep a quiescent pre-upgrade backup; an older executable is not a rollback writer for an upgraded library. Restore offline under the documented [migration and rollback rules](named-inboxes.md#upgrade-to-060). Existing storage and private-control checks remain mandatory.

## Activation requirements

Modern activation requires driver qualification, pre-storage runtime rejection, exact-archive tests on Node 24.19.0 and Node 26, and format-aware skill resolution. Raising the runtime minimum later requires a deliberate release-policy change, never a silent patch. Package engines, CI, package smoke checks, READMEs, website and both skills must agree at activation. See the [implementation receipt and remaining gates](performance/88-prerequisite-validation.md) for current validation status.
