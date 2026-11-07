"""Reproduce #92 against private-storage.ts from 52cdb70 only.

This one-off POSIX comparison rejects other source bytes, including formatting
changes. Never use real libraries or parallel builds. SIGINT/SIGTERM defer exit
until the active command finishes, then restore source and rebuild before exit.
SIGKILL and machine failure cannot be handled.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess


def digest(data):
    return hashlib.sha256(data).hexdigest()


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

    def run(label, command, expected=0):
        check_interruption()

        result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=300)
        (out / f"{label}.log").write_text(result.stdout + result.stderr)
        with (out / "commands.jsonl").open("a") as manifest:
            manifest.write(json.dumps({"label": label, "command": command,
                                       "cwd": str(root), "exit": result.returncode}) + "\n")

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

    if digest(original) != "000d77f9dbd585e3f10ea393f03a6e59049980d4d3aae34a219e2cbfd4413e62":
        raise RuntimeError("Expected private-storage.ts bytes from 52cdb70")

    (out / "baseline.ts").write_bytes(original)
    run("build-baseline", ["pnpm", "build"])
    fingerprint("baseline")

    for label, node in [("20", args.node20), ("24", args.node24)]:
        run(f"node-{label}", [node, "--version"])
        run(f"baseline-{label}", [node, "--test", "--test-reporter=tap",
                                 "packages/cli/dist/private-storage.test.js"])

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
            if "# pass 0\n" not in output or "# fail 4\n" not in output:
                raise RuntimeError(f"Expected all four candidate tests to fail on Node {label}")
    except BaseException as error:
        failure = error
    finally:
        is_restoring = True

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
