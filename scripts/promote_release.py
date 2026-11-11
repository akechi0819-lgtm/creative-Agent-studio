#!/usr/bin/env python3
"""Validate artifacts from a successful native build before creating a Release."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path


RELEASES = {
    "personal": {
        "branch": "main",
        "workflow": ".github/workflows/release.yml",
        "product": "Creative Agent Studio",
        "archive_prefix": "Creative-Agent-Studio-",
        "native_jobs": {
            "Build darwin-arm64 on its native runner",
            "Build win32-x64 on its native runner",
        },
    },
    "company": {
        "branch": "codex/company-edition",
        "workflow": ".github/workflows/company-release.yml",
        "product": "Creative Agent Studio Company",
        "archive_prefix": "Creative-Agent-Studio-Company-",
        "native_jobs": {
            "Build Company darwin-arm64 on its native runner",
            "Build Company win32-x64 on its native runner",
        },
    },
}

TARGETS = {
    "darwin-arm64": ("darwin", "arm64", "macOS-arm64"),
    "win32-x64": ("win32", "x64", "Windows-x64"),
}
VERSION_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}\Z")
SHA_PATTERN = re.compile(r"([0-9a-f]{64})  ([^\r\n]+)\Z")


def _gh_json(repository, endpoint):
    result = subprocess.run(
        ["gh", "api", f"repos/{repository}/{endpoint}"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ValueError("GitHub could not verify the selected source run.")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ValueError("GitHub returned invalid source-run metadata.") from error


def verify_source_run(run, jobs, repository, edition):
    if edition not in RELEASES:
        raise ValueError("Unsupported release edition.")
    rules = RELEASES[edition]
    if (run.get("repository") or {}).get("full_name") != repository:
        raise ValueError("Source run is not from this repository.")
    if (run.get("head_repository") or {}).get("full_name") != repository:
        raise ValueError("Source run is not from this repository's own branch.")
    if run.get("path") != rules["workflow"] or run.get("head_branch") != rules["branch"]:
        raise ValueError("Source run does not match the selected edition workflow and branch.")
    if run.get("event") not in {"push", "workflow_dispatch"}:
        raise ValueError("Source run was not started by an accepted release event.")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError("Source run has not completed successfully.")
    head_sha = run.get("head_sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        raise ValueError("Source run does not have a valid commit SHA.")

    successful_jobs = {
        job.get("name")
        for job in jobs
        if job.get("status") == "completed" and job.get("conclusion") == "success"
    }
    if not rules["native_jobs"].issubset(successful_jobs):
        raise ValueError("Both native platform build jobs must have succeeded.")
    return head_sha


def _write_outputs(output_path, values):
    with open(output_path, "a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def validate_run_command(args):
    if not re.fullmatch(r"[0-9]+", args.run_id):
        raise ValueError("Source run ID must be numeric.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        raise ValueError("Repository name is invalid.")
    run = _gh_json(args.repository, f"actions/runs/{args.run_id}")
    job_data = _gh_json(args.repository, f"actions/runs/{args.run_id}/jobs?per_page=100")
    head_sha = verify_source_run(run, job_data.get("jobs", []), args.repository, args.edition)
    _write_outputs(args.output, {"head_sha": head_sha})
    print("Source run provenance and native build jobs verified.")


def _sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _files_in_artifact_directory(directory):
    if not directory.is_dir():
        raise ValueError("A downloaded artifact directory is missing.")
    entries = list(directory.iterdir())
    if any(entry.is_symlink() or not entry.is_file() for entry in entries):
        raise ValueError("Artifact directory contains an unexpected entry.")
    archives = [entry for entry in entries if entry.name.endswith(".zip")]
    if len(archives) != 1:
        raise ValueError("Each native artifact must contain exactly one product ZIP.")
    archive = archives[0]
    sidecar = Path(f"{archive}.sha256")
    if set(entries) != {archive, sidecar} or not sidecar.is_file():
        raise ValueError("Each native artifact must contain only its ZIP and SHA-256 sidecar.")
    return archive, sidecar


def _read_unique_json(bundle, filename):
    matches = [name for name in bundle.namelist() if name == filename or name.endswith(f"/{filename}")]
    if len(matches) != 1:
        raise ValueError(f"Package must contain exactly one {filename}.")
    try:
        return json.loads(bundle.read(matches[0]))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Package contains invalid {filename}.") from error


def verify_archive(archive_path, sidecar_path, edition, target):
    if edition not in RELEASES:
        raise ValueError("Unsupported release edition.")
    if target not in TARGETS:
        raise ValueError("Unsupported release target.")

    sidecar = sidecar_path.read_text(encoding="utf-8").strip()
    match = SHA_PATTERN.fullmatch(sidecar)
    if not match or match.group(2) != archive_path.name:
        raise ValueError("Product ZIP SHA-256 sidecar is invalid.")
    if _sha256(archive_path) != match.group(1):
        raise ValueError("Product ZIP does not match its SHA-256 sidecar.")

    try:
        with zipfile.ZipFile(archive_path) as bundle:
            manifest = _read_unique_json(bundle, "release-manifest.json")
            inventory = _read_unique_json(bundle, "THIRD-PARTY-LICENSES.json")
    except (OSError, zipfile.BadZipFile) as error:
        raise ValueError("Product ZIP is unreadable.") from error

    if not isinstance(manifest, dict) or not isinstance(inventory, dict):
        raise ValueError("Product ZIP contains an invalid release manifest or license inventory.")

    rules = RELEASES[edition]
    platform, architecture, filename_target = TARGETS[target]
    version = manifest.get("version", "")
    if not VERSION_PATTERN.fullmatch(version) or version.startswith("v"):
        raise ValueError("Package version cannot be used as the requested non-v release tag.")
    profile = manifest.get("profile")
    profile_matches = profile == "company" if edition == "company" else profile is None
    if (
        not profile_matches
        or manifest.get("product") != rules["product"]
        or manifest.get("target") != target
        or manifest.get("platform") != platform
        or manifest.get("architecture") != architecture
    ):
        raise ValueError("Package manifest does not match the selected edition and native target.")

    expected_name = f"{rules['archive_prefix']}{version}-{filename_target}.zip"
    if archive_path.name != expected_name:
        raise ValueError("Product ZIP filename does not match its manifest version and target.")

    gate = inventory.get("releaseLicenseGate")
    if not isinstance(gate, dict) or gate.get("status") != "evidence-complete" or gate.get("blockers") != []:
        raise ValueError("Package release license evidence gate is blocked or incomplete.")
    return {"version": version, "archive": str(archive_path), "sidecar": str(sidecar_path)}


def verify_artifact_directories(edition, darwin_directory, windows_directory):
    if edition not in RELEASES:
        raise ValueError("Unsupported release edition.")
    platform_inputs = {
        "darwin-arm64": Path(darwin_directory),
        "win32-x64": Path(windows_directory),
    }
    verified = {}
    for target, directory in platform_inputs.items():
        archive, sidecar = _files_in_artifact_directory(directory)
        verified[target] = verify_archive(archive, sidecar, edition, target)
    versions = {item["version"] for item in verified.values()}
    if len(versions) != 1:
        raise ValueError("Native package manifests do not use the same version.")
    version = versions.pop()
    values = {"version": version}
    for target, item in verified.items():
        key = "darwin" if target == "darwin-arm64" else "windows"
        values[f"{key}_archive"] = item["archive"]
        values[f"{key}_sidecar"] = item["sidecar"]
    return values


def verify_artifacts_command(args):
    values = verify_artifact_directories(args.edition, args.darwin_dir, args.windows_dir)
    _write_outputs(args.output, values)
    print("Both native ZIPs, SHA-256 sidecars, manifests, and license gates verified.")


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("validate-run")
    run_parser.add_argument("--edition", choices=RELEASES, required=True)
    run_parser.add_argument("--repository", required=True)
    run_parser.add_argument("--run-id", required=True)
    run_parser.add_argument("--output", required=True)

    artifacts_parser = subparsers.add_parser("verify-artifacts")
    artifacts_parser.add_argument("--edition", choices=RELEASES, required=True)
    artifacts_parser.add_argument("--darwin-dir", required=True)
    artifacts_parser.add_argument("--windows-dir", required=True)
    artifacts_parser.add_argument("--output", required=True)

    args = parser.parse_args(argv)
    try:
        if args.command == "validate-run":
            validate_run_command(args)
        else:
            verify_artifacts_command(args)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
