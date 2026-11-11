import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.promote_release import verify_archive, verify_artifact_directories, verify_source_run


REPOSITORY = "akechi0819-lgtm/creative-Agent-studio"


def make_package(directory, edition="personal", version="media-workflow.2", target="darwin-arm64", gate_status="evidence-complete", blockers=None):
    company = edition == "company"
    product = "Creative Agent Studio Company" if company else "Creative Agent Studio"
    profile = "company" if company else "general"
    platform, architecture, filename_target = {
        "darwin-arm64": ("darwin", "arm64", "macOS-arm64"),
        "win32-x64": ("win32", "x64", "Windows-x64"),
    }[target]
    prefix = "Creative-Agent-Studio-Company-" if company else "Creative-Agent-Studio-"
    archive_path = directory / f"{prefix}{version}-{filename_target}.zip"
    manifest = {
        "schemaVersion": 1,
        "product": product,
        "version": version,
        "target": target,
        "platform": platform,
        "architecture": architecture,
    }
    if company:
        manifest["profile"] = profile
    inventory = {"releaseLicenseGate": {"status": gate_status, "blockers": blockers if blockers is not None else []}}
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("product/release-manifest.json", json.dumps(manifest))
        bundle.writestr("product/THIRD-PARTY-LICENSES.json", json.dumps(inventory))
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    sidecar = Path(f"{archive_path}.sha256")
    sidecar.write_text(f"{digest}  {archive_path.name}\n", encoding="utf-8")
    return archive_path, sidecar


class PromotionValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_valid_personal_and_company_package_contracts(self):
        personal, personal_sidecar = make_package(self.root, "personal", "media-workflow.2")
        company, company_sidecar = make_package(self.root, "company", "company-media.2")
        self.assertEqual(verify_archive(personal, personal_sidecar, "personal", "darwin-arm64")["version"], "media-workflow.2")
        self.assertEqual(verify_archive(company, company_sidecar, "company", "darwin-arm64")["version"], "company-media.2")

    def test_rejects_bad_sidecar_hash(self):
        archive, sidecar = make_package(self.root)
        sidecar.write_text(f"{'0' * 64}  {archive.name}\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "does not match"):
            verify_archive(archive, sidecar, "personal", "darwin-arm64")

    def test_rejects_edition_mismatch(self):
        archive, sidecar = make_package(self.root, "company", "company-media.2")
        with self.assertRaisesRegex(ValueError, "manifest does not match"):
            verify_archive(archive, sidecar, "personal", "darwin-arm64")

    def test_rejects_version_that_would_trigger_existing_v_tag_build(self):
        archive, sidecar = make_package(self.root, "personal", "v2.0")
        with self.assertRaisesRegex(ValueError, "non-v release tag"):
            verify_archive(archive, sidecar, "personal", "darwin-arm64")

    def test_rejects_different_versions_between_native_targets(self):
        darwin_dir = self.root / "darwin"
        windows_dir = self.root / "windows"
        darwin_dir.mkdir()
        windows_dir.mkdir()
        make_package(darwin_dir, "personal", "media-workflow.2", "darwin-arm64")
        make_package(windows_dir, "personal", "media-workflow.3", "win32-x64")
        with self.assertRaisesRegex(ValueError, "same version"):
            verify_artifact_directories("personal", darwin_dir, windows_dir)

    def test_rejects_blocked_or_missing_license_gate(self):
        archive, sidecar = make_package(self.root, gate_status="blocked", blockers=["missing notice"])
        with self.assertRaisesRegex(ValueError, "license evidence gate"):
            verify_archive(archive, sidecar, "personal", "darwin-arm64")

    def test_rejects_source_run_from_wrong_workflow_or_branch(self):
        run = {
            "repository": {"full_name": REPOSITORY},
            "head_repository": {"full_name": REPOSITORY},
            "path": ".github/workflows/release.yml",
            "head_branch": "codex/company-edition",
            "event": "workflow_dispatch",
            "status": "completed",
            "conclusion": "success",
            "head_sha": "a" * 40,
        }
        jobs = [
            {"name": "Build darwin-arm64 on its native runner", "status": "completed", "conclusion": "success"},
            {"name": "Build win32-x64 on its native runner", "status": "completed", "conclusion": "success"},
        ]
        with self.assertRaisesRegex(ValueError, "workflow and branch"):
            verify_source_run(run, jobs, REPOSITORY, "personal")

    def test_accepts_company_run_from_its_actual_branch_and_workflow(self):
        run = {
            "repository": {"full_name": REPOSITORY},
            "head_repository": {"full_name": REPOSITORY},
            "path": ".github/workflows/company-release.yml",
            "head_branch": "codex/company-edition",
            "event": "push",
            "status": "completed",
            "conclusion": "success",
            "head_sha": "b" * 40,
        }
        jobs = [
            {"name": "Build Company darwin-arm64 on its native runner", "status": "completed", "conclusion": "success"},
            {"name": "Build Company win32-x64 on its native runner", "status": "completed", "conclusion": "success"},
        ]
        self.assertEqual(verify_source_run(run, jobs, REPOSITORY, "company"), "b" * 40)


if __name__ == "__main__":
    unittest.main()
