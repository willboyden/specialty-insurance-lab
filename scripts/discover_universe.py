"""List every SEC filer that reported property-casualty premiums in an annual XBRL frame, 2008-2025.

This is how the curated universe in sil/universe.py was found: run it, read the names and SIC codes, and
classify each carrier by its own business description. SIC codes alone are not enough (Argo Group, a specialty
carrier, is filed under SIC 6361, title insurance).

    .venv/bin/python -m scripts.discover_universe > universe_candidates.tsv
"""

from __future__ import annotations

import sys
from collections import defaultdict

from sil.http import Fetcher

TAGS = ("PremiumsEarnedNet", "PremiumsWrittenNet", "PremiumsEarnedNetPropertyAndCasualty")
YEARS = range(2008, 2026)


def main() -> None:
    f = Fetcher()
    seen: dict[int, dict] = defaultdict(lambda: {"name": None, "years": set(), "npe": {}})
    for tag in TAGS:
        for y in YEARS:
            frame = f.get_json(f"https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/CY{y}.json", allow_404=True)
            for row in (frame or {}).get("data", []):
                s = seen[row["cik"]]
                s["name"] = row["entityName"]
                s["years"].add(y)
                if tag != "PremiumsWrittenNet":
                    s["npe"][y] = row["val"]
    print(f"{len(seen)} entities", file=sys.stderr)
    print("sic\tcik\tname\ttickers\tfirst_year\tlast_year\tmax_npe_bn")
    rows = []
    for cik, s in seen.items():
        sub = f.get_json(f"https://data.sec.gov/submissions/CIK{cik:010d}.json") or {}
        npe = round(max(s["npe"].values()) / 1e9, 2) if s["npe"] else ""
        rows.append((sub.get("sic") or "", cik, sub.get("name") or s["name"], ",".join(sub.get("tickers") or []),
                     min(s["years"]), max(s["years"]), npe))
    for r in sorted(rows, key=lambda r: (str(r[0]), -(r[6] or 0))):
        print("\t".join(str(x) for x in r))


if __name__ == "__main__":
    main()
