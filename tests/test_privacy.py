"""Nothing personal in the published repository: no email address in any tracked text file."""

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
ALLOWED = ("@users.noreply.github.com", "@example.com", "@example.invalid")
SKIP_SUFFIXES = (".png", ".jpg", ".ico", ".woff", ".woff2", ".pkl", ".gz", ".zip")


def test_no_email_addresses_in_tracked_files():
    files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=ROOT, capture_output=True,
                           text=True, check=True).stdout.split()
    found = []
    for name in files:
        path = ROOT / name
        if name.endswith(SKIP_SUFFIXES) or not path.is_file() or path.stat().st_size > 5_000_000:
            continue
        text = path.read_text(errors="ignore")
        for m in EMAIL.finditer(text):
            hit = m.group(0)
            if hit.endswith(ALLOWED) or re.search(r"@\d", hit) or hit.split("@")[1].count(".") == 0:
                continue
            # npm scoped packages and versions look like emails only without a dot-TLD; keep real addresses
            found.append(f"{name}: {hit[:3]}...@{hit.split('@')[1]}")
    assert not found, "email-like strings in tracked files: " + "; ".join(found[:10])
