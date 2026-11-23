"""Reproduce #92 against private-storage.ts from 52cdb70 only.

This one-off POSIX comparison rejects other source bytes, including formatting
changes. Run it only in a clean, disposable checkout with no concurrent builds
or Git writes. Its first `pnpm build` deletes and regenerates packages/cli/dist,
so it restores a fresh baseline build, not whatever dist existed before. pnpm
must not need an install: the build runs without a TTY. Never use real
libraries.

A SIGINT or SIGTERM delivered to this runner's PID is deferred until the active
command finishes, then source is restored and rebuilt before exit. A terminal
or process-group signal also reaches the build itself. The 300-second command
timeout kills only the direct child, so descendants of a timed-out build may
still write packages/cli/dist. After a timeout the runner restores source bytes,
skips the rebuild, records build restoration as unverified and exits; discard
that checkout. SIGKILL and machine failure cannot be handled.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess


CASES = [
    ("private file removed after inspection still reports ENOENT",
     "error: 'Missing expected rejection.'"),
    ("private file replaced after inspection still repairs the replacement",
     "511 !== 384"),
    ("private directory removed after inspection still reports ENOENT",
     "error: 'Missing expected rejection.'"),
    ("private directory replaced after inspection still repairs the replacement",
     "511 !== 448"),
]


class CommandTimedOut(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def tap_results(output):
    """Map each top-level TAP test name to (passed, its diagnostic block)."""
    results = {}
    current = None

    for line in output.splitlines():
        for prefix, passed in [("not ok ", False), ("ok ", True)]:
            if line.startswith(prefix):
                _number, separator, name = line[len(prefix):].partition(" - ")
                if not separator:
                    raise RuntimeError(f"TAP result has no test name: {line!r}")

                current = results[name] = [passed, []]
                break
        else:
            if current is not None and line.startswith("  "):
                current[1].append(line)
            elif not line.startswith("  "):
                current = None

    return {name: (passed, "\n".join(block)) for name, (passed, block) in results.items()}


def check_baseline(output):
    results = tap_results(output)

    if "# pass 4\n" not in output or "# fail 0\n" not in output:
        raise RuntimeError("Expected exactly four passing baseline tests")

    for name, _diagnostic in CASES:
        if results.get(name, (False, ""))[0] is not True:
            raise RuntimeError(f"Baseline case did not pass: {name}")


def check_candidate(output):
    results = tap_results(output)

    if "# pass 0\n" not in output or "# fail 4\n" not in output:
        raise RuntimeError("Expected all four candidate tests to fail")

    for name, diagnostic in CASES:
        passed, block = results.get(name, (True, ""))
        if passed or diagnostic not in block:
            raise RuntimeError(f"Candidate case did not fail with {diagnostic!r}: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--node20", required=True)
    parser.add_argument("--node24", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = root / "packages/cli/src/private-storage.ts"
    original = source.read_bytes()
    fingerprints = {}
    interrupted_signal = None
    is_restoring = False

    def request_stop(signum, _frame):
        nonlocal interrupted_signal
        interrupted_signal = signum

    def check_interruption():
        if interrupted_signal is not None and not is_restoring:
            raise InterruptedError(f"Received signal {interrupted_signal}; restoring before exit")

    if os.name != "posix":
        raise RuntimeError("This comparison requires POSIX mode semantics")

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    def record(label, command, exit_status):
        with (out / "commands.jsonl").open("a") as manifest:
            manifest.write(json.dumps({"label": label, "command": command,
                                       "cwd": str(root), "exit": exit_status}) + "\n")

    def run(label, command, expected=0):
        check_interruption()

        try:
            result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired as error:
            (out / f"{label}.log").write_text((error.stdout or "") + (error.stderr or ""))
            record(label, command, "timeout")
            raise CommandTimedOut(f"{label}: timed out after 300 seconds") from error

        (out / f"{label}.log").write_text(result.stdout + result.stderr)
        record(label, command, result.returncode)

        check_interruption()

        if result.returncode != expected:
            raise RuntimeError(f"{label}: expected exit {expected}, got {result.returncode}")

        return result.stdout

    def fingerprint(label):
        fingerprints[label] = {
            "source": digest(source.read_bytes()),
            "build": {str(file.relative_to(root)): digest(file.read_bytes())
                      for file in sorted((root / "packages/cli/dist").glob("**/*"))
                      if file.is_file()},
        }
        (out / "fingerprints.json").write_text(json.dumps(fingerprints, indent=2) + "\n")

    run("head", ["git", "rev-parse", "HEAD"])
    run("status", ["git", "status", "--porcelain"])
    run("source-clean", ["git", "diff", "--quiet", "HEAD", "--", str(source)])
    run("source-index-clean", ["git", "diff", "--quiet", "--cached", "HEAD", "--", str(source)])

    if digest(original) != "000d77f9dbd585e3f10ea393f03a6e59049980d4d3aae34a219e2cbfd4413e62":
        raise RuntimeError("Expected private-storage.ts bytes from 52cdb70")

    (out / "baseline.ts").write_bytes(original)
    run("build-baseline", ["pnpm", "build"])
    fingerprint("baseline")

    for label, node in [("20", args.node20), ("24", args.node24)]:
        version = run(f"node-{label}", [node, "--version"])
        if not version.startswith(f"v{label}."):
            raise RuntimeError(f"--node{label} reports {version.strip()}")

        output = run(f"baseline-{label}", [node, "--test", "--test-reporter=tap",
                                          "packages/cli/dist/private-storage.test.js"])
        check_baseline(output)

    candidate = original
    for target, mode in [("directoryPath", "PRIVATE_DIRECTORY_MODE"),
                         ("filePath", "PRIVATE_FILE_MODE")]:
        before = f"  await chmod({target}, {mode});".encode()
        after = (f'  if (process.platform === "win32" || (fileStat.mode & 0o7777) !== {mode}) {{\n'
                 f"    await chmod({target}, {mode});\n  }}").encode()
        if candidate.count(before) != 1:
            raise RuntimeError(f"Expected exactly one chmod for {target}")

        candidate = candidate.replace(before, after)

    failure = None
    try:
        check_interruption()
        source.write_bytes(candidate)
        (out / "candidate.ts").write_bytes(candidate)
        run("candidate-diff", ["git", "diff", "--", str(source)])
        run("build-candidate", ["pnpm", "build"])
        fingerprint("candidate")

        for label, node in [("20", args.node20), ("24", args.node24)]:
            output = run(f"candidate-{label}", [node, "--test", "--test-reporter=tap",
                                               "packages/cli/dist/private-storage.test.js"], expected=1)
            check_candidate(output)
    except BaseException as error:
        failure = error
    finally:
        is_restoring = True

        if isinstance(failure, CommandTimedOut):
            source.write_bytes(original)
            (out / "restoration.json").write_text(json.dumps({
                "sourceByteIdentical": source.read_bytes() == original,
                "allBuildHashesIdentical": None,
                "buildRestoration": "skipped after timeout; discard this checkout",
            }, indent=2) + "\n")
            raise failure

        try:
            source.write_bytes(original)
            is_source_restored = source.read_bytes() == original
            run("build-restored", ["pnpm", "build"])
            fingerprint("restored")
            is_build_restored = fingerprints["baseline"] == fingerprints["restored"]
            (out / "restoration.json").write_text(json.dumps({
                "sourceByteIdentical": is_source_restored,
                "allBuildHashesIdentical": is_build_restored,
            }, indent=2) + "\n")

            if not is_source_restored or not is_build_restored:
                raise RuntimeError("Restored source/build differs from baseline")
        except BaseException as restoration_error:
            if failure is not None:
                raise RuntimeError(f"Restoration failed: {restoration_error}") from failure

            raise

    if failure is not None:
        raise failure

    is_restoring = False
    check_interruption()


if __name__ == "__main__":
    main()
