"""The hand-selected company universe.

How it was built (the candidate list is scripts/discover_universe.py's output, kept in docs/universe_candidates.tsv):
1. Every SEC filer that tagged us-gaap PremiumsEarnedNet / PremiumsWrittenNet in any annual XBRL frame
   from 2008 to 2025 (262 entities, life and health included).
2. Property-casualty carriers kept (SIC 6331/6351/6399, plus mis-coded ones found by reading names:
   Argo Group is filed under SIC 6361, title insurance).
3. "Specialty" = the company's own description of its business is excess & surplus (E&S), specialty
   commercial, specialty (re)insurance or a single niche line (workers' comp for hazardous industries,
   medical professional liability). Personal-lines, title, mortgage and financial-guaranty carriers are out.
4. Companies that were acquired or stopped filing during 2009-2026 stay IN the universe, so peer averages
   are not biased toward the survivors.
   Pure property-catastrophe and life or casualty reinsurers (PartnerRe, Platinum, Montpelier, Flagstone,
   Greenlight Re, Maiden) are left out; RenaissanceRe and Everest stay because they also run specialty insurance
   platforms. The selection is a judgment call, written down here, not an exhaustive census.
5. A benchmark cohort of standard commercial and personal lines carriers, for comparison.
6. Six AI-infrastructure spenders, used only for an AI-capex indicator (capital expenditure tags).

Status notes say what the filing index shows (form types and dates) or what was widely reported (acquirer and year).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Company:
    cik: int
    ticker: str
    short_name: str
    cohort: str  # specialty | benchmark | ai_indicator
    segment: str
    status: str = "active"  # active | acquired | exited
    status_year: int | None = None
    status_note: str | None = None
    include_note: str | None = None
    comparable: bool = True  # False: consolidated lines mix in non-P&C business; kept out of models and averages


ES = "E&S and specialty commercial"
DIV = "Diversified specialty"
BDA = "Bermuda and international specialty (re)insurance"
NICHE = "Niche specialty (workers' comp, medical liability)"
STD = "Standard commercial and personal lines"
AI = "AI infrastructure spender"

COMPANIES: list[Company] = [
    # ---- E&S and specialty commercial
    Company(1669162, "KNSL", "Kinsale Capital", "specialty", ES),
    Company(84246, "RLI", "RLI Corp", "specialty", ES),
    Company(1519449, "SKWD", "Skyward Specialty", "specialty", ES),
    Company(2002473, "BOW", "Bowhead Specialty", "specialty", ES),
    Company(1620459, "JRVR", "James River Group", "specialty", ES),
    Company(1494904, "GBLI", "Global Indemnity", "specialty", ES),
    Company(2040491, "ASIC", "Ategrity Specialty", "specialty", ES),
    Company(1761312, "PLMR", "Palomar Holdings", "specialty", ES, include_note="specialty property (earthquake, wind, flood)"),
    Company(1997350, "ARX", "Accelerant Holdings", "specialty", ES, include_note="specialty risk exchange (insurer + MGA platform)"),
    Company(1502292, "PRHI", "Presurance (Conifer)", "specialty", ES, include_note="formerly Conifer Holdings"),
    Company(793547, "NAVG", "Navigators Group", "specialty", ES, "acquired", 2019, "acquired by The Hartford"),
    Company(888919, "HCC", "HCC Insurance", "specialty", ES, "acquired", 2015, "acquired by Tokio Marine"),
    Company(1091748, "ARGO", "Argo Group", "specialty", ES, "acquired", 2023, "acquired by Brookfield Reinsurance",
            "filed under SIC 6361 (title insurance); classified by its own business description"),
    Company(1289592, "TWGP", "Tower Group", "specialty", ES, "acquired", 2014, "acquired by ACP Re after reserve charges"),
    Company(949156, "MIG", "Meadowbrook (AmeriTrust)", "specialty", ES, "acquired", 2015, "acquired by Fosun"),
    Company(783603, "ASI", "American Safety Insurance", "specialty", ES, "acquired", 2013, "acquired by Fairfax"),
    Company(1634038, "PROS", "ProSight Global", "specialty", ES, "acquired", 2021, "taken private"),
    Company(819913, "HALL", "Hallmark Financial", "specialty", ES, "exited", 2023, "last 10-Q Q3 2023; deregistered (Form 15) January 2024"),
    Company(1539894, "AFH", "Atlas Financial", "specialty", ES, "exited", 2020,
            "commercial auto specialist; premium data ends Q3 2019; delisted 2020 (Form 25), registration revoked 2024"),
    Company(9346, "PTVCB", "Protective Insurance", "specialty", ES, "acquired", 2021, "acquired by Progressive"),
    Company(1301106, "NATL", "National Interstate", "specialty", ES, "acquired", 2016, "acquired by American Financial Group"),
    Company(1610793, "SNC", "State National", "specialty", ES, "acquired", 2017, "acquired by Markel"),
    Company(1801754, "TIG", "Trean Insurance", "specialty", ES, "acquired", 2023, "taken private by Altaris"),
    # ---- Diversified specialty
    Company(11544, "WRB", "W. R. Berkley", "specialty", DIV),
    Company(1096343, "MKL", "Markel Group", "specialty", DIV),
    Company(1042046, "AFG", "American Financial Group", "specialty", DIV),
    Company(775368, "Y", "Alleghany", "specialty", DIV, "acquired", 2022, "acquired by Berkshire Hathaway"),
    Company(1369817, "OB", "OneBeacon", "specialty", DIV, "acquired", 2017, "acquired by Intact"),
    # ---- Bermuda and international specialty (re)insurance
    Company(947484, "ACGL", "Arch Capital", "specialty", BDA, include_note="consolidated figures include mortgage insurance"),
    Company(1214816, "AXS", "AXIS Capital", "specialty", BDA),
    Company(1095073, "EG", "Everest Group", "specialty", BDA),
    Company(913144, "RNR", "RenaissanceRe", "specialty", BDA),
    Company(1593275, "HG", "Hamilton Insurance", "specialty", BDA),
    Company(1636639, "PLGO", "Pelagos (Fidelis)", "specialty", BDA, include_note="formerly Fidelis Insurance Holdings"),
    Company(1576018, "SPNT", "SiriusPoint", "specialty", BDA, include_note="formerly Third Point Re"),
    Company(1794338, "IGIC", "International General", "specialty", BDA),
    Company(1267395, "AHL", "Aspen Insurance", "specialty", BDA, "acquired", 2019,
            "acquired by Apollo; common stock deregistered 2019 (Form 15); 20-F annual reports since, no quarterly data"),
    Company(1163348, "AWH", "Allied World", "specialty", BDA, "acquired", 2017, "acquired by Fairfax"),
    Company(1179755, "ENH", "Endurance Specialty", "specialty", BDA, "acquired", 2017, "acquired by Sompo"),
    Company(875159, "XL", "XL Group", "specialty", BDA, "acquired", 2018, "acquired by AXA"),
    Company(1348259, "VR", "Validus", "specialty", BDA, "acquired", 2018, "acquired by AIG"),
    Company(1141719, "ALTE", "Alterra Capital", "specialty", BDA, "acquired", 2013, "acquired by Markel"),
    # ---- Niche specialty
    Company(1018979, "AMSF", "AMERISAFE", "specialty", NICHE),
    Company(1379041, "EIG", "Employers Holdings", "specialty", NICHE),
    Company(1127703, "PRA", "ProAssurance", "specialty", NICHE),
    Company(1365555, "AFSI", "AmTrust Financial", "specialty", NICHE, "acquired", 2018, "taken private"),
    Company(1267201, "SBX", "SeaBright", "specialty", NICHE, "acquired", 2013, "acquired by Enstar"),
    # ---- Benchmark: standard commercial and personal lines
    Company(86312, "TRV", "Travelers", "benchmark", STD),
    Company(896159, "CB", "Chubb", "benchmark", STD, include_note="consolidated premium and loss lines include life insurance; kept out of the model and peer averages", comparable=False),
    Company(874766, "HIG", "The Hartford", "benchmark", STD, include_note="consolidated premium and loss lines include group benefits (disability, life); kept out of the model and peer averages", comparable=False),
    Company(21175, "CNA", "CNA Financial", "benchmark", STD, include_note="consolidated premium and loss lines include long-term care; kept out of the model and peer averages", comparable=False),
    Company(20286, "CINF", "Cincinnati Financial", "benchmark", STD),
    Company(230557, "SIGI", "Selective Insurance", "benchmark", STD),
    Company(944695, "THG", "Hanover Insurance", "benchmark", STD),
    Company(80661, "PGR", "Progressive", "benchmark", STD),
    Company(899051, "ALL", "Allstate", "benchmark", STD, include_note="no consistent loss tag in recent filings; kept out of the model and peer averages", comparable=False),
    # ---- AI-capex indicator (only capital-expenditure and revenue tags are kept)
    Company(789019, "MSFT", "Microsoft", "ai_indicator", AI),
    Company(1652044, "GOOGL", "Alphabet", "ai_indicator", AI),
    Company(1018724, "AMZN", "Amazon", "ai_indicator", AI),
    Company(1326801, "META", "Meta Platforms", "ai_indicator", AI),
    Company(1341439, "ORCL", "Oracle", "ai_indicator", AI),
    Company(1045810, "NVDA", "NVIDIA", "ai_indicator", AI),
]

# For AI-indicator companies only these tags are loaded (their full fact sets are irrelevant here).
AI_INDICATOR_TAGS = {
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "NetCashProvidedByUsedInOperatingActivities",
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
}


def by_cik() -> dict[int, Company]:
    return {c.cik: c for c in COMPANIES}


def insurers() -> list[Company]:
    return [c for c in COMPANIES if c.cohort != "ai_indicator"]
