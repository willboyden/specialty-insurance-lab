"""A polite, caching HTTP client.

- Per-host rate limit (SEC asks for at most 10 requests per second; we use 8).
- Retries with exponential backoff on 429, 5xx and network errors.
- Every response body is cached on disk under data/cache/<host>/ with a small metadata file,
  so a re-run reads the cache instead of the network unless the entry is older than max_age.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .config import CACHE, USER_AGENT

log = logging.getLogger(__name__)

HOST_RPS = {
    "data.sec.gov": 8.0,
    "efts.sec.gov": 6.0,
    "www.sec.gov": 8.0,
    "fred.stlouisfed.org": 4.0,
    "www.fema.gov": 4.0,
}


class FetchError(RuntimeError):
    pass


class Fetcher:
    def __init__(self, cache_dir: Path = CACHE, user_agent: str = USER_AGENT, timeout: float = 120.0):
        self.cache_dir = cache_dir
        self.client = httpx.Client(
            headers={"User-Agent": user_agent, "Accept-Encoding": "gzip, deflate"},
            timeout=timeout,
            follow_redirects=True,
            http2=False,  # FRED resets HTTP/2 streams; HTTP/1.1 is reliable everywhere
        )
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()
        self.network_requests = 0
        self.cache_hits = 0

    def _paths(self, url: str) -> tuple[Path, Path]:
        host = urlsplit(url).netloc
        key = hashlib.sha256(url.encode()).hexdigest()[:32]
        base = self.cache_dir / host
        return base / key, base / f"{key}.meta.json"

    def _throttle(self, host: str) -> None:
        rps = HOST_RPS.get(host, 2.0)
        with self._lock:
            wait = self._last.get(host, 0.0) + 1.0 / rps - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self._last[host] = time.monotonic()

    def get(self, url: str, *, max_age_s: float | None = None, allow_404: bool = False) -> bytes | None:
        """Return the body for url (from cache when fresh enough). None only for an allowed 404."""
        body_path, meta_path = self._paths(url)
        if body_path.exists() and meta_path.exists():
            meta = json.loads(meta_path.read_text())
            age = time.time() - meta.get("fetched_at", 0)
            if max_age_s is None or age < max_age_s:
                self.cache_hits += 1
                if meta.get("status") == 404:
                    return None
                return body_path.read_bytes()
        host = urlsplit(url).netloc
        delay = 2.0
        last_error = ""
        for attempt in range(6):
            self._throttle(host)
            try:
                resp = self.client.get(url)
                self.network_requests += 1
            except httpx.HTTPError as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                log.warning("GET %s failed (%s), retry %d", url, last_error, attempt + 1)
                time.sleep(delay)
                delay *= 2
                continue
            if resp.status_code == 404 and allow_404:
                self._store(body_path, meta_path, url, 404, b"")
                return None
            if resp.status_code == 200:
                self._store(body_path, meta_path, url, 200, resp.content)
                return resp.content
            last_error = f"HTTP {resp.status_code}"
            if resp.status_code in (429, 500, 502, 503, 504):
                log.warning("GET %s -> %s, retry %d", url, resp.status_code, attempt + 1)
                time.sleep(delay)
                delay *= 2
                continue
            break
        raise FetchError(f"GET {url}: {last_error}")

    def get_json(self, url: str, **kw) -> dict | list | None:
        body = self.get(url, **kw)
        return None if body is None else json.loads(body)

    @staticmethod
    def _store(body_path: Path, meta_path: Path, url: str, status: int, body: bytes) -> None:
        body_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = body_path.with_suffix(".tmp")
        tmp.write_bytes(body)
        tmp.replace(body_path)
        meta_path.write_text(json.dumps({"url": url, "status": status, "fetched_at": time.time(),
                                         "bytes": len(body)}))
