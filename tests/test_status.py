"""The listing-status rule (sil/status.py) on hand-made filing records."""

from datetime import date

from sil.status import classify

TODAY = date(2026, 11, 17)


def test_listed_and_reporting_is_active():
    assert classify(True, date(2026, 11, 5), [], None, TODAY) == "active"


def test_acquired_after_last_10q_is_inactive():
    # ProAssurance: last 10-Q 2026-05-05, delisted after the June closing -> no longer among SEC-listed tickers
    assert classify(False, date(2026, 5, 5), [("DEFM14A", date(2025, 5, 14))], date(2026, 6, 26), TODAY) == "inactive"


def test_stale_reporting_is_inactive_even_if_listed():
    assert classify(True, date(2025, 12, 1), [], None, TODAY) == "inactive"


def test_merger_proxy_in_last_year_is_pending():
    docs = [("PREM14A", date(2026, 8, 28)), ("SC 13E3", date(2026, 8, 31)), ("DEFM14A", date(2026, 10, 14))]
    assert classify(True, date(2026, 11, 3), docs, None, TODAY) == "pending"


def test_change_of_control_after_the_deal_documents_closes_the_deal():
    docs = [("DEFM14A", date(2026, 3, 1))]
    assert classify(True, date(2026, 11, 3), docs, date(2026, 5, 2), TODAY) == "active"


def test_old_deal_documents_do_not_count():
    assert classify(True, date(2026, 11, 3), [("DEFM14A", date(2025, 6, 1))], None, TODAY) == "active"
