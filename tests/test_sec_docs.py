"""SEC document plumbing without the network: index parsing, document choice, HTML to text, host identity."""

import pytest

from sil.http import Fetcher, FetchError, is_sec_host
from sil.sources.sec_docs import html_to_text, parse_index, wanted

INDEX = """
<html><body>
<table class="tableFile" summary="Document Format Files">
<tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
<tr><td>1</td><td>10-K</td><td><a href="/ix?doc=/Archives/edgar/data/1669162/000166916226000010/knsl-20251231.htm">knsl-20251231.htm</a></td><td>10-K</td><td>4473689</td></tr>
<tr><td>2</td><td>EXHIBIT 21</td><td><a href="/Archives/edgar/data/1669162/000166916226000010/ex21.htm">ex21.htm</a></td><td>EX-21</td><td>3021</td></tr>
</table>
<table class="tableFile" summary="Data Files">
<tr><th>Seq</th><th>Description</th><th>Document</th><th>Type</th><th>Size</th></tr>
<tr><td>8</td><td>EXTRACTED XBRL INSTANCE DOCUMENT</td><td><a href="/Archives/edgar/data/1669162/000166916226000010/knsl-20251231_htm.xml">knsl-20251231_htm.xml</a></td><td>XML</td><td>2981233</td></tr>
</table></body></html>
"""


def test_parse_index_reads_both_tables_and_strips_the_viewer_prefix():
    rows = parse_index(INDEX)
    assert [r["filename"] for r in rows] == ["knsl-20251231.htm", "ex21.htm", "knsl-20251231_htm.xml"]
    assert rows[0]["url"] == "https://www.sec.gov/Archives/edgar/data/1669162/000166916226000010/knsl-20251231.htm"
    assert rows[0]["doc_type"] == "10-K" and rows[0]["size_bytes"] == 4473689 and rows[0]["seq"] == 1


def test_wanted_picks_primary_and_instance_of_annual_reports():
    rows = parse_index(INDEX)
    assert [r["filename"] for r in rows if wanted("annual", "10-K", r)] == ["knsl-20251231.htm", "knsl-20251231_htm.xml"]
    press = {"doc_type": "EX-99.1", "filename": "ex991.htm", "size_bytes": 90_000}
    assert wanted("earnings", "8-K", press) and wanted("deal", "8-K", press)
    assert not wanted("earnings", "8-K", {**press, "size_bytes": 10**9})


def test_html_to_text_drops_the_hidden_inline_xbrl_header_and_keeps_cells():
    doc = ('<html><body><div style="display: none"><ix:header>dei:EntityRegistrantName 999</ix:header></div>'
           "<p>As of December 31, 2025, we had approximately 1,234&nbsp;employees.</p>"
           "<table><tr><td>Catastrophe losses</td><td>$ 41.2</td></tr></table></body></html>")
    text = html_to_text(doc)
    assert "999" not in text
    assert "approximately 1,234 employees." in text
    assert "Catastrophe losses | $ 41.2" in text


def test_sec_hosts_get_the_declared_client_and_others_the_generic_name():
    f = Fetcher(sec_agent="declared-client")
    assert all(f._agent(h) == "declared-client" for h in ("www.sec.gov", "data.sec.gov", "efts.sec.gov"))
    assert f._agent("fred.stlouisfed.org") == f.user_agent != "declared-client"
    assert is_sec_host("efts.sec.gov") and not is_sec_host("sec.gov.example.com")


def test_www_sec_gov_without_a_declared_client_fails_before_any_request(tmp_path):
    f = Fetcher(cache_dir=tmp_path, sec_agent="")
    with pytest.raises(FetchError, match="SIL_SEC_USER_AGENT"):
        f.get("https://www.sec.gov/Archives/edgar/data/1/")
    assert f.network_requests == 0
