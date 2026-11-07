"""Linux-only synthetic qualification of the #92 review fixes, after a slot grant."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def digest(data):
    return hashlib.sha256(data).hexdigest()


def group_members(group):
    members = []

    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue

        try:
            fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
            if int(fields[2]) == group:
                members.append({"pid": int(entry.name), "state": fields[0],
                                "startTime": fields[19],
                                "command": (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode()})
        except (FileNotFoundError, ProcessLookupError):
            continue

    return members


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--node20", required=True)
    parser.add_argument("--node24", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[4]
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    source = root / "packages/cli/src/private-storage.ts"
    original = source.read_bytes()
    index = Path(subprocess.check_output(["git", "rev-parse", "--git-path", "index"], cwd=root, text=True).strip())
    if not index.is_absolute():
        index = root / index

    original_index = index.read_bytes()
    baseline = json.loads((out.parent / "comparison/fingerprints.json").read_text())["restored"]
    runner = ["python3", "scripts/bench/permissions.py", "--node20", args.node20, "--node24", args.node24]
    receipts = {}

    def run(label, command, expected=0, env=None):
        with (out / f"{label}.log").open("w") as log:
            result = subprocess.run(command, cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                    timeout=300, env=env)

        with (out / "commands.jsonl").open("a") as manifest:
            manifest.write(json.dumps({"label": label, "command": command,
                                       "cwd": str(root), "exit": result.returncode}) + "\n")

        if result.returncode != expected:
            raise RuntimeError(f"{label}: expected {expected}, got {result.returncode}")

    def index_entry():
        return subprocess.check_output(["git", "ls-files", "--stage", "--", str(source)], cwd=root, text=True)

    def build_hashes():
        return {str(file.relative_to(root)): digest(file.read_bytes())
                for file in sorted((root / "packages/cli/dist").rglob("*")) if file.is_file()}

    try:
        for kind in ["unstaged", "staged"]:
            try:
                source.write_bytes(original + b"\n// Synthetic #92 source preflight fixture.\n")
                if kind == "staged":
                    run("stage-fixture", ["git", "add", "--", str(source)])

                before_entry = index_entry()
                edited = source.read_bytes()
                run(f"refuse-{kind}", runner + ["--out", str(out / kind)], expected=1)
                receipts[kind] = {"editedSourceUnchanged": source.read_bytes() == edited,
                                  "indexEntryUnchanged": index_entry() == before_entry,
                                  "noBuildStarted": not (out / kind / "build-baseline.log").exists()}
                if not all(receipts[kind].values()):
                    raise RuntimeError(f"{kind} preflight changed the fixture or started a build")
            finally:
                source.write_bytes(original)
                index.write_bytes(original_index)
                receipts.setdefault(kind, {}).update({"outerSourceRestored": source.read_bytes() == original,
                                                      "outerIndexBytesRestored": index.read_bytes() == original_index})

        signal_out = out / "signal"
        command = runner + ["--out", str(signal_out)]
        with (out / "signal.log").open("w") as log:
            child = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            observed = {}

            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    members = group_members(child.pid)
                    observed.update({member["pid"]: member for member in members})
                    snapshot = signal_out / "candidate.ts"
                    is_candidate = snapshot.exists() and source.read_bytes() == snapshot.read_bytes()
                    build_members = [member for member in members
                                     if member["pid"] != child.pid and "pnpm" in member["command"]
                                     and "build" in member["command"]]

                    if is_candidate and build_members:
                        receipts["signal"] = {"runnerPid": child.pid, "groupId": child.pid,
                                              "signal": "SIGTERM", "signalTarget": "runner PID only",
                                              "phase": "candidate source installed; pnpm build member observed",
                                              "sourceAtSignal": digest(source.read_bytes()),
                                              "membersBeforeSignal": members}
                        os.kill(child.pid, signal.SIGTERM)
                        break

                    if child.poll() is not None:
                        raise RuntimeError("Runner exited before the candidate-build signal checkpoint")

                    time.sleep(0.005)
                else:
                    raise RuntimeError("Candidate-build signal checkpoint timed out")

                while child.poll() is None:
                    observed.update({member["pid"]: member for member in group_members(child.pid)})
                    if time.monotonic() > deadline + 60:
                        raise RuntimeError("Interrupted runner did not finish restoration")

                    time.sleep(0.005)

                exit_code = child.wait()
                if exit_code != 1:
                    raise RuntimeError(f"Expected interrupted runner exit 1, got {exit_code}")

                deadline = time.monotonic() + 5
                while group_members(child.pid) and time.monotonic() < deadline:
                    time.sleep(0.01)

                remaining = group_members(child.pid)
                receipts["signal"].update({"exit": exit_code, "observedMembers": list(observed.values()),
                                           "remainingGroupMembers": remaining,
                                           "restoration": json.loads((signal_out / "restoration.json").read_text())})
                if remaining or not all(receipts["signal"]["restoration"].values()):
                    raise RuntimeError("Interrupted runner left processes or unverified restoration")
            finally:
                if child.poll() is None or group_members(child.pid):
                    # Emergency cleanup is distinct from the exercised runner-only SIGTERM.
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()

        files = ["private-storage", "private-json", "backend-listing", "backend-records", "storage-cleanup",
                 "local-document-source", "inbox-catalog", "sync-store", "sync-storage-faults", "sync-reader-compatibility"]
        for label, node in [("20", args.node20), ("24", args.node24)]:
            env = dict(os.environ, PATH=str(Path(node).parent) + ":" + os.environ["PATH"])
            run(f"regressions-{label}", [node, "--test", "--test-reporter=tap",
                                        "packages/cli/dist/private-storage.test.js"], env=env)
            run(f"targeted-{label}", [node, "--test", "--test-reporter=tap",
                                     *[f"packages/cli/dist/{file}.test.js" for file in files]], env=env)
    finally:
        source.write_bytes(original)
        index.write_bytes(original_index)
        receipts["outerFinally"] = {"sourceByteIdentical": source.read_bytes() == original,
                                    "indexByteIdentical": index.read_bytes() == original_index,
                                    "sourceSha256": digest(source.read_bytes()),
                                    "indexSha256": digest(index.read_bytes())}

        if build_hashes() != baseline["build"]:
            run("outer-restoration-build", ["pnpm", "build"])

        receipts["outerFinally"]["allBuildHashesMatch"] = build_hashes() == baseline["build"]
        (out / "receipts.json").write_text(json.dumps(receipts, indent=2) + "\n")

    if not all(receipts["outerFinally"][key] for key in ["sourceByteIdentical", "indexByteIdentical", "allBuildHashesMatch"]):
        raise RuntimeError("Outer restoration was incomplete")


if __name__ == "__main__":
    main()
