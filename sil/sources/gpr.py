"""Geopolitical Risk (GPR) index, Caldara and Iacoviello (American Economic Review, 2022).

Monthly, from newspaper coverage of geopolitical tension. GPR (1985-), GPRH (historical, 1900-), the
threats (T) and acts (A) components, and country-level indexes (GPRC_*). Loaded in long format.
"""

from __future__ import annotations

import io
import logging
import math

import pandas as pd

from ..db import copy_rows, ingest_run
from ..http import Fetcher

log = logging.getLogger(__name__)
URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_export.xls"


def ingest(conn, fetcher: Fetcher) -> None:
    with ingest_run(conn, "gpr") as info:
        body = fetcher.get(URL, max_age_s=7 * 24 * 3600)
        frame = pd.read_excel(io.BytesIO(body), sheet_name=0, engine="xlrd")
        if "month" not in frame.columns or "GPR" not in frame.columns:
            raise RuntimeError(f"unexpected GPR layout: {list(frame.columns)[:8]}")
        rows = []
        for col in frame.columns:
            if col == "month" or not pd.api.types.is_numeric_dtype(frame[col]):
                continue
            for month, value in zip(frame["month"], frame[col]):
                if value is None or (isinstance(value, float) and math.isnan(value)):
                    continue
                rows.append((pd.Timestamp(month).date().replace(day=1), col, float(value)))
        conn.execute("delete from raw.gpr_observation")
        info["rows"] = copy_rows(conn, "raw.gpr_observation", ("month", "variable", "value"), rows)
        conn.commit()
        info["detail"] = {"variables": int(frame.shape[1] - 1), "last_month": str(frame["month"].max())[:10]}
        log.info("gpr: %d observations, last month %s", info["rows"], info["detail"]["last_month"])
