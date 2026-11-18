"""List every SEC filer that reported property-casualty premiums in an XBRL frame, 2008 to now.

This is how the curated universe in sil/universe.py was found and is kept current: run it, read the names and
SIC codes, and classify each carrier by its own business description. SIC codes alone are not enough (Argo
Group, a specialty carrier, is filed under SIC 6361, title insurance; Orion180, listed in 2025, under 6411).
Annual frames cover 2008 to last year; quarterly frames of the last two years catch carriers that listed
recently and have not filed a 10-K yet.

    uv run python -m scripts.discover_universe > docs/universe_candidates.tsv
"""

from __future__ import annotations

import sys
from collections import defaultdict
from datetime import date

from sil.http import Fetcher

TAGS = ("PremiumsEarnedNet", "PremiumsWrittenNet", "PremiumsEarnedNetPropertyAndCasualty")
DAY = 24 * 3600


def periods(today: date) -> list[tuple[str, int]]:
    """(frame period, calendar year): annual frames 2008..last year, quarterly frames of the last two years."""
    out = [(f"CY{y}", y) for y in range(2008, today.year)]
    out += [(f"CY{y}Q{q}", y) for y in (today.year - 1, today.year) for q in (1, 2, 3, 4)]
    return out


def main() -> None:
    f = Fetcher()
    seen: dict[int, dict] = defaultdict(lambda: {"name": None, "years": set(), "npe": {}})
    for tag in TAGS:
        for period, year in periods(date.today()):
            # past annual frames do not change; recent ones are refreshed daily
            max_age = None if "Q" not in period and year < date.today().year - 1 else DAY
            frame = f.get_json(f"https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/USD/{period}.json",
                               allow_404=True, max_age_s=max_age)
            for row in (frame or {}).get("data", []):
                s = seen[row["cik"]]
                s["name"] = row["entityName"]
                s["years"].add(year)
                if tag != "PremiumsWrittenNet" and "Q" not in period:
                    s["npe"][year] = row["val"]
    print(f"{len(seen)} entities", file=sys.stderr)
    print("sic\tcik\tname\ttickers\tfirst_frame_year\tlast_frame_year\tmax_premiums_earned_bn\t"
          "state_of_incorporation\tformer_name")
    rows = []
    for cik, s in seen.items():
        sub = f.get_json(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", max_age_s=7 * DAY) or {}
        npe = round(max(s["npe"].values()) / 1e9, 2) if s["npe"] else ""
        former = (sub.get("formerNames") or [{}])[0].get("name", "")
        rows.append((sub.get("sic") or "", cik, sub.get("name") or s["name"], ",".join(sub.get("tickers") or []),
                     min(s["years"]), max(s["years"]), npe, sub.get("stateOfIncorporation") or "", former))
    for r in sorted(rows, key=lambda r: (str(r[0]), -(r[6] or 0))):
        print("\t".join(str(x) for x in r))


if __name__ == "__main__":
    main()
