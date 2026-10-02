#!/usr/bin/env python3
"""Offline integrity checks for the lark-ticket-collector plugin package."""

from __future__ import annotations

import json
import hashlib
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_MANIFEST = ROOT / ".codex-plugin" / "plugin.json"
SKILLS_DIR = ROOT / "skills"
PACKAGE_MANIFEST = ROOT / "MANIFEST.txt"
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
ABSOLUTE_HOME_RE = re.compile(r"/(?:Users|home)/[^/\s]+/")
IGNORED_PARTS = {"node_modules", "dist", "var", "__pycache__"}
IGNORED_FILES = {".DS_Store", ".env"}


def is_ignored(path: Path) -> bool:
    return path.name in IGNORED_FILES or bool(IGNORED_PARTS.intersection(path.parts))


def load_json(path: Path, errors: list[str]) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{path.relative_to(ROOT)}: invalid JSON: {exc}")
        return None


def check_manifest(errors: list[str]) -> None:
    data = load_json(PLUGIN_MANIFEST, errors)
    if not isinstance(data, dict):
        return
    required = ("name", "version", "description", "author", "interface", "skills")
    for key in required:
        if not data.get(key):
            errors.append(f".codex-plugin/plugin.json: missing {key!r}")
    plugin_name = data.get("name")
    source_layout = ROOT.name == plugin_name
    installed_cache_layout = ROOT.parent.name == plugin_name
    if not (source_layout or installed_cache_layout):
        errors.append(
            "plugin name must match the source directory or installed-cache parent"
        )
    if data.get("skills") != "./skills/":
        errors.append("plugin skills path must be './skills/'")


def check_skills(errors: list[str]) -> None:
    skill_files = sorted(SKILLS_DIR.glob("*/SKILL.md"))
    if not skill_files:
        errors.append("no skills/*/SKILL.md files found")
        return
    for skill_file in skill_files:
        text = skill_file.read_text(encoding="utf-8")
        match = re.search(r"(?m)^name:\s*[\"']?([^\"'\n]+)", text)
        if not match:
            errors.append(f"{skill_file.relative_to(ROOT)}: missing frontmatter name")
        elif match.group(1).strip() != skill_file.parent.name:
            errors.append(
                f"{skill_file.relative_to(ROOT)}: name does not match directory"
            )
        if not (skill_file.parent / "agents" / "openai.yaml").is_file():
            errors.append(f"{skill_file.parent.relative_to(ROOT)}: missing agents/openai.yaml")


def check_json_files(errors: list[str]) -> None:
    for path in sorted(ROOT.rglob("*.json")):
        if is_ignored(path):
            continue
        load_json(path, errors)


def check_package_manifest(errors: list[str]) -> None:
    try:
        lines = PACKAGE_MANIFEST.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        errors.append(f"MANIFEST.txt: unable to read: {exc}")
        return

    declared: dict[str, str] = {}
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        parts = line.split(maxsplit=1)
        if len(parts) != 2 or re.fullmatch(r"[0-9a-f]{64}", parts[0]) is None:
            errors.append(f"MANIFEST.txt:{line_number}: malformed entry")
            continue
        digest, relative_name = parts
        if relative_name in declared:
            errors.append(f"MANIFEST.txt:{line_number}: duplicate path {relative_name}")
            continue
        declared[relative_name] = digest

    actual = {
        path.relative_to(ROOT).as_posix()
        for path in ROOT.rglob("*")
        if path.is_file()
        and path != PACKAGE_MANIFEST
        and not is_ignored(path)
        and path.suffix != ".pyc"
    }
    missing = actual - declared.keys()
    stale = declared.keys() - actual
    for relative_name in sorted(missing):
        errors.append(f"MANIFEST.txt: missing file entry: {relative_name}")
    for relative_name in sorted(stale):
        errors.append(f"MANIFEST.txt: stale file entry: {relative_name}")

    for relative_name in sorted(actual & declared.keys()):
        payload = (ROOT / relative_name).read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        if digest != declared[relative_name]:
            errors.append(f"MANIFEST.txt: checksum mismatch: {relative_name}")


def check_markdown_links_and_paths(errors: list[str]) -> None:
    for path in sorted(ROOT.rglob("*.md")):
        if is_ignored(path):
            continue
        text = path.read_text(encoding="utf-8")
        if ABSOLUTE_HOME_RE.search(text):
            errors.append(f"{path.relative_to(ROOT)}: contains a machine-bound home path")
        for raw_target in LINK_RE.findall(text):
            target = raw_target.strip().split("#", 1)[0]
            if not target or "://" in target or target.startswith("mailto:"):
                continue
            looks_like_file = (
                target.startswith(("./", "../", "/"))
                or "/" in target
                or Path(target).suffix.lower() in {".md", ".json", ".yaml", ".yml"}
            )
            if not looks_like_file:
                continue
            decoded = target.replace("%20", " ")
            resolved = (path.parent / decoded).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                errors.append(
                    f"{path.relative_to(ROOT)}: link leaves package: {raw_target}"
                )
                continue
            if not resolved.exists():
                errors.append(
                    f"{path.relative_to(ROOT)}: broken local link: {raw_target}"
                )


def main() -> int:
    errors: list[str] = []
    check_manifest(errors)
    check_skills(errors)
    check_json_files(errors)
    check_markdown_links_and_paths(errors)
    check_package_manifest(errors)
    if errors:
        print("Package check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Package check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
