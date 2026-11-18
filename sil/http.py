"""A polite, caching HTTP client.

- Rate limits: every *.sec.gov host shares one budget of 8 requests per second across ALL processes of this
  project (a lock file under data/cache/.ratelimit/; SEC allows at most 10 per second per client); other
  hosts have a per-process limit.
- Identity by host: SEC hosts get the declared client from SIL_SEC_USER_AGENT when it is set (www.sec.gov
  refuses requests without one); every other host gets the generic client name. The contact never leaves SEC.
- Retries with exponential backoff on 429, 5xx and network errors.
- Every response body is cached on disk under data/cache/<host>/ with a small metadata file,
  so a re-run reads the cache instead of the network unless the entry is older than max_age.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .config import CACHE, USER_AGENT, sec_user_agent

log = logging.getLogger(__name__)

HOST_RPS = {
    "fred.stlouisfed.org": 4.0,
    "www.fema.gov": 4.0,
}
SEC_SHARED_RPS = 8.0


def is_sec_host(host: str) -> bool:
    return host == "sec.gov" or host.endswith(".sec.gov")


class FetchError(RuntimeError):
    pass


class Fetcher:
    def __init__(self, cache_dir: Path = CACHE, user_agent: str = USER_AGENT, timeout: float = 120.0,
                 sec_agent: str | None = None):
        self.cache_dir = cache_dir
        self.user_agent = user_agent
        self.sec_agent = sec_agent if sec_agent is not None else sec_user_agent()
        self.client = httpx.Client(
            headers={"Accept-Encoding": "gzip, deflate"},
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

    def _agent(self, host: str) -> str:
        if is_sec_host(host) and self.sec_agent:
            return self.sec_agent
        return self.user_agent

    def _throttle_shared(self, key: str, rps: float) -> None:
        """One budget across processes: the last request time lives in a lock file under the cache."""
        lock_dir = self.cache_dir / ".ratelimit"
        lock_dir.mkdir(parents=True, exist_ok=True)
        with open(lock_dir / f"{key}.lock", "a+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                fh.seek(0)
                text = fh.read().strip()
                last = float(text) if text else 0.0
                wait = last + 1.0 / rps - time.time()
                if wait > 0:
                    time.sleep(wait)
                fh.seek(0)
                fh.truncate()
                fh.write(f"{time.time():.6f}")
                fh.flush()
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def _throttle(self, host: str) -> None:
        if is_sec_host(host):
            self._throttle_shared("sec.gov", SEC_SHARED_RPS)
            return
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
        if host == "www.sec.gov" and not self.sec_agent:
            raise FetchError(
                "www.sec.gov refuses clients that do not declare a contact: set SIL_SEC_USER_AGENT in .env "
                "(\"<name> <email>\"), see the README"
            )
        delay = 2.0
        last_error = ""
        for attempt in range(6):
            self._throttle(host)
            try:
                resp = self.client.get(url, headers={"User-Agent": self._agent(host)})
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
