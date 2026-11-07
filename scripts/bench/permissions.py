"""Synthetic #92 contract comparison. Never use real libraries or parallel builds."""

import argparse
import hashlib
import json
from pathlib import Path
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

    def run(label, command, expected=0):
        result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=300)
        (out / f"{label}.log").write_text(result.stdout + result.stderr)
        with (out / "commands.jsonl").open("a") as manifest:
            manifest.write(json.dumps({"label": label, "command": command,
                                       "cwd": str(root), "exit": result.returncode}) + "\n")

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
        assert candidate.count(before) == 1
        candidate = candidate.replace(before, after)

    try:
        source.write_bytes(candidate)
        (out / "candidate.ts").write_bytes(candidate)
        run("candidate-diff", ["git", "diff", "--", str(source)])
        run("build-candidate", ["pnpm", "build"])
        fingerprint("candidate")

        for label, node in [("20", args.node20), ("24", args.node24)]:
            output = run(f"candidate-{label}", [node, "--test", "--test-reporter=tap",
                                               "packages/cli/dist/private-storage.test.js"], expected=1)
            assert "# pass 0\n" in output and "# fail 4\n" in output
    finally:
        source.write_bytes(original)
        assert source.read_bytes() == original
        run("build-restored", ["pnpm", "build"])
        fingerprint("restored")
        assert fingerprints["baseline"] == fingerprints["restored"]
        (out / "restoration.json").write_text(json.dumps({
            "sourceByteIdentical": True, "allBuildHashesIdentical": True,
        }, indent=2) + "\n")


if __name__ == "__main__":
    main()
