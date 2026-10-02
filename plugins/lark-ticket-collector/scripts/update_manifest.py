#!/usr/bin/env python3
"""Regenerate MANIFEST.txt for publishable plugin files."""

from __future__ import annotations

import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "MANIFEST.txt"
IGNORED_PARTS = {"node_modules", "dist", "var", "__pycache__"}
IGNORED_FILES = {".DS_Store", ".env", "MANIFEST.txt"}


def included(path: Path) -> bool:
    return (
        path.is_file()
        and path.name not in IGNORED_FILES
        and not IGNORED_PARTS.intersection(path.relative_to(ROOT).parts)
        and path.suffix != ".pyc"
    )


def main() -> None:
    entries: list[str] = []
    for path in sorted((path for path in ROOT.rglob("*") if included(path))):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        entries.append(f"{digest}  {path.relative_to(ROOT).as_posix()}")
    MANIFEST.write_text("\n".join(entries) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} entries to {MANIFEST.name}")


if __name__ == "__main__":
    main()
