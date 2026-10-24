# CI190 first-round review disposition

Both independent reviewers read the same complete12-file/165-source/328-compiled pin against190ff7853e8a85cebb2d7983b14ae83b53f95b09. Their full reports are preserved verbatim as review-ci190-r1-sol.txt and review-ci190-r1-astra.txt. Both accepted the retained sender ownership boundary and browser diagnostics as observation only.

Astra raised CI190-A1, Medium, at sync-protocol.test.ts:465. The shared runSender hardcoded1000ms for both passes. At HEAD only the first faulted pass supplied1000ms; the final successful retry inherited SYNC_DEFAULTS.attemptMs=5000. The current fast passes did not establish preservation of that timing allowance. Accept the finding and restore5000ms explicitly for the final retry. The first1000ms request,25000ms case/reply observation and30000ms reconciliation pass remain. No production timeout, security assertion or cleanup oracle changes.

Sol noted the stricter retry in its report but accepted it. Repository source/defaults settle the disagreement: preserving the original retry envelope is the narrower fixture-only correction. No new timing reproduction or hosted-cause claim is made.

Final typecheck/build,97-case containing suites on20/24.21, complete24.21 verification and complete20units pass on identical corrected bytes. Current source d7f1e5bb, compiled5830eda8. See qa-ci190-combined-verification.md and verification-qa.json. Two NEW focused confirmations are required before logical follow-up commits. All prior failed/interrupted observations and timing/cleanup qualifications remain.

The Ubuntu hosted cleanup actor and Windows navigation actor remain unknown. Windows behavior is not changed. PhysicalQA remains parked; no reviewedSHA is released here.

## Final focused confirmations

Two NEW independent Codex reviewers accepted the same15-file/165-source/328-compiled final pin. Both full reports were read, copied verbatim as review-ci190-r2-sol.txt and review-ci190-r2-astra.txt, and their source/status/index/log/resource receipts verified. Each independently passed both crash cases on exact20.20.2 and24.21.0. Node20's37name-filter exclusions are not passed cases. The static call chain proves1000ms first pass and5000ms final retry; no new timing failure is claimed. Sender ownership and browser diagnostics remain accepted under the full rubric, with no new actionable findings.

Both reviewer drivers and16captured test/fixture PIDs each are absent; four exact captured loopback ports per reviewer were rebound and private environments removed. The reviewers' scratch-audit mistakes were corrected without runtime reruns or repository writes and remain recorded. Prior cleanup/timestamp/provider-interruption qualifications are retained.

Current local verification and651current/historical log pins are verified. Logical follow-up commits and the next ordinary published-head native checks are coordinator work. No change to production behavior was made in this CI190 response. The Windows trace is observation only and both historical hosted actors remain unknown. No SHA is released to physicalQA by these reviews.
