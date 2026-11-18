"""OpenFEMA Disaster Declarations Summaries (v2): every federal disaster declaration, by designated area."""

from __future__ import annotations

import logging
from datetime import date

from ..db import copy_rows, ingest_run
from ..http import Fetcher

log = logging.getLogger(__name__)
BASE = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"
FIELDS = (
    "id,disasterNumber,state,declarationType,declarationDate,incidentType,declarationTitle,incidentBeginDate,"
    "incidentEndDate,designatedArea,fipsStateCode,fipsCountyCode,ihProgramDeclared,iaProgramDeclared,"
    "paProgramDeclared,hmProgramDeclared"
)
PAGE = 10000


def _d(value):
    return date.fromisoformat(value[:10]) if value else None


def ingest(conn, fetcher: Fetcher) -> None:
    with ingest_run(conn, "fema") as info:
        rows, skip = [], 0
        while True:
            url = f"{BASE}?$select={FIELDS}&$orderby=id&$top={PAGE}&$skip={skip}&$inlinecount=allpages"
            data = fetcher.get_json(url, max_age_s=24 * 3600)
            batch = data["DisasterDeclarationsSummaries"]
            total = data["metadata"]["count"]
            for r in batch:
                rows.append((
                    r["id"], r["disasterNumber"], r.get("state"), r.get("declarationType"),
                    _d(r.get("declarationDate")), r.get("incidentType"), r.get("declarationTitle"),
                    _d(r.get("incidentBeginDate")), _d(r.get("incidentEndDate")), r.get("designatedArea"),
                    r.get("fipsStateCode"), r.get("fipsCountyCode"), r.get("ihProgramDeclared"),
                    r.get("iaProgramDeclared"), r.get("paProgramDeclared"), r.get("hmProgramDeclared"),
                ))
            skip += PAGE
            if not batch or skip >= total:
                break
        if len(rows) != total:
            raise RuntimeError(f"FEMA returned {len(rows)} rows, metadata says {total}")
        conn.execute("delete from raw.fema_declaration")
        info["rows"] = copy_rows(
            conn, "raw.fema_declaration",
            ("id", "disaster_number", "state", "declaration_type", "declaration_date", "incident_type",
             "declaration_title", "incident_begin", "incident_end", "designated_area", "fips_state", "fips_county",
             "ih_program", "ia_program", "pa_program", "hm_program"),
            rows,
        )
        conn.commit()
        log.info("fema: %d declaration rows", info["rows"])
