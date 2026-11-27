#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ysplive 管理界面（飞牛 fnOS 原生应用）

在 8767 对用户提供统一入口（IPv4 + IPv6 双栈监听）：网页管理界面 + 合并订阅 + 反向代理到内部引擎。
引擎（ysp-live.py）只监听 127.0.0.1:8788，不直接对外，所有请求经本文件转发。

仅使用 Python 标准库。
"""

from __future__ import annotations

import argparse
import base64
import ipaddress
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
import gzip
import http.client
import io
import datetime
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")

DATA_DIR = ""
ENGINE_PORT = 8788
UI_PORT = 8767
CONFIG_PATH = ""
CFG_LOCK = threading.Lock()

MAX_CFG_BYTES = 512 * 1024

DEFAULT_CONFIG = {
    "site": {
        "title": "央视频直播",
        "notice": "央视 + 卫视 64 路 · 7 天时移回看 · 支持网页直接播放",
    },
    "overrides": {},
    "hidden": [],
    "custom": [],
}

EXT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


# ---------------------------------------------------------------- 版本检查 / 升级

APP_REPO = "zyp1690/ysplive"
UPDATE_DIR = "updates"
UPDATE_CACHE_TTL = 600.0
UPDATE_META_URL = os.environ.get("YSP_UPDATE_META_URL", "").strip()
UPDATE_RAW_BASES = (
    "https://raw.githubusercontent.com/%s/main" % APP_REPO,
    "https://cdn.jsdelivr.net/gh/%s@main" % APP_REPO,
    "https://gh-proxy.com/https://raw.githubusercontent.com/%s/main" % APP_REPO,
)
UPDATE_CHECK_INTERVAL = float(os.environ.get("YSP_UPDATE_INTERVAL", "21600") or 21600)
_update_lock = threading.Lock()
_update_cache = {"at": 0.0, "data": None, "busy": False}


def current_version() -> str:
    """读引擎文件里的 __version__，保证和实际跑的代码一致。"""
    try:
        with open(os.path.join(BASE_DIR, "ysp-live.py"), "r", encoding="utf-8", errors="replace") as f:
            head = f.read(4096)
        m = re.search(r"__version__\s*=\s*'([^']+)'", head)
        if m:
            return m.group(1)
    except OSError:
        pass
    return "0.0.0"


def _ver_key(v: str):
    nums = re.findall(r"\d+", v or "")
    out = [int(x) for x in nums[:4]]
    while len(out) < 4:
        out.append(0)
    return tuple(out)


def _gh_json(url: str, timeout: float = 10.0):
    req = urllib.request.Request(url, headers={
        "User-Agent": "ysplive-updater",
        "Accept": "application/vnd.github+json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _gh_text(url: str, timeout: float = 10.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "ysplive-updater"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def check_update(force: bool = False) -> dict:
    """比对 GitHub 仓库最新版本。

    先读仓库里的 ysplive/fpk/latest.json（单个文件，不受 GitHub API 每分钟限流影响，
    download_url 里可以直接写国内 CDN 地址）；读不到再退回 GitHub API 列目录。
    """
    now = time.time()
    with _update_lock:
        cached = _update_cache["data"]
        if (not force) and cached and now - _update_cache["at"] < UPDATE_CACHE_TTL:
            return cached
        if _update_cache["busy"]:
            return cached or {"current": current_version(), "latest": "", "has_update": False,
                              "error": "正在检查，请稍候"}
        _update_cache["busy"] = True

    info = {
        "current": current_version(),
        "latest": "",
        "has_update": False,
        "notes": "",
        "fpk_url": "",
        "fpk_name": "",
        "sha256": "",
        "size": 0,
        "checked_at": int(now),
        "repo": APP_REPO,
        "source": "",
        "error": "",
    }
    try:
        raw_ok = False
        if UPDATE_META_URL:
            meta = _gh_json(UPDATE_META_URL, timeout=10.0)
            if isinstance(meta, dict) and meta.get("version"):
                info["latest"] = str(meta.get("version"))
                info["fpk_name"] = str(meta.get("fpk") or "")
                info["fpk_url"] = str(meta.get("url") or "")
                info["sha256"] = str(meta.get("sha256") or "").lower()
                info["size"] = int(meta.get("size") or 0)
                info["notes"] = str(meta.get("notes") or "")
                info["source"] = "meta_url"
                raw_ok = True
        for base in (UPDATE_RAW_BASES if not raw_ok else ()):
            try:
                meta = _gh_json(base + "/ysplive/fpk/latest.json", timeout=8.0)
                if isinstance(meta, dict) and meta.get("version"):
                    info["latest"] = str(meta.get("version"))
                    info["fpk_name"] = str(meta.get("fpk") or "")
                    info["fpk_url"] = str(meta.get("url") or "")
                    info["sha256"] = str(meta.get("sha256") or "").lower()
                    info["size"] = int(meta.get("size") or 0)
                    info["notes"] = str(meta.get("notes") or "")
                    info["source"] = "latest.json"
                    raw_ok = True
                    break
            except Exception:
                continue
        if not raw_ok:
            listing = _gh_json("https://api.github.com/repos/%s/contents/ysplive/fpk?ref=main" % APP_REPO)
            if not isinstance(listing, list):
                raise ValueError("仓库返回格式异常")
            best = None
            sha_files = set()
            for item in listing:
                if not isinstance(item, dict):
                    continue
                name = item.get("name") or ""
                if name.endswith(".fpk.sha256"):
                    sha_files.add(name)
                m = re.search(r"(\d+\.\d+\.\d+)", name)
                if name.endswith(".fpk") and m:
                    if best is None or _ver_key(m.group(1)) > _ver_key(best[0]):
                        best = (m.group(1), item)
            if not best:
                raise ValueError("仓库里还没有安装包")
            ver, item = best
            info["latest"] = ver
            info["fpk_name"] = item.get("name", "")
            info["fpk_url"] = item.get("download_url") or ""
            info["size"] = int(item.get("size") or 0)
            info["source"] = "contents"
            sha_name = info["fpk_name"] + ".sha256"
            if sha_name in sha_files:
                try:
                    raw = _gh_text(UPDATE_RAW_BASES[0] + "/ysplive/fpk/%s" % sha_name)
                    parts = raw.split()
                    if parts:
                        info["sha256"] = parts[0].strip().lower()
                except Exception:
                    pass

        info["has_update"] = _ver_key(info["latest"]) > _ver_key(info["current"])
    except Exception as exc:  # noqa: BLE001
        msg = "%s: %s" % (type(exc).__name__, exc)
        low = msg.lower()
        if "rate limit" in low or "403" in low:
            msg = "GitHub 接口限流（同一出口 IP 每小时次数用尽），请稍后再试；也可在配置里设 YSP_UPDATE_META_URL 指向自己维护的 latest.json"
        elif "timed out" in low or "urlopen error" in low:
            msg = "连不上 GitHub（可能被网络阻断或 IPv6 不通），可设 YSP_UPDATE_META_URL 走自有 CDN"
        info["error"] = msg
    finally:
        with _update_lock:
            _update_cache["busy"] = False
            if not info["error"]:
                _update_cache["data"] = info
                _update_cache["at"] = time.time()
    return info


def cached_update_info() -> dict:
    """给 /api/state 用：只读缓存，过期就后台补一次，绝不阻塞页面。"""
    with _update_lock:
        data = _update_cache["data"]
        stale = (not data) or (time.time() - _update_cache["at"] > UPDATE_CHECK_INTERVAL)
    if stale:
        threading.Thread(target=check_update, daemon=True).start()
    return data or {"current": current_version(), "latest": "", "has_update": False,
                    "error": "", "checking": True}


def download_update() -> dict:
    """下载新包到 data/updates/ 并校验 sha256。返回路径，供应用中心手动安装。"""
    info = check_update(force=True)
    if info.get("error"):
        raise RuntimeError("检测失败：%s" % info["error"])
    url = info.get("fpk_url") or ""
    name = info.get("fpk_name") or ""
    if not url or not name:
        raise RuntimeError("没有可下载的安装包地址")
    if not re.match(r"^[\w.\-]+\.fpk$", name):
        raise RuntimeError("安装包文件名不合法：%s" % name)
    dest_dir = os.path.join(DATA_DIR, UPDATE_DIR)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, name)

    candidates = [url]
    for base in UPDATE_RAW_BASES:
        candidates.append(base + "/ysplive/fpk/" + name)
    tmp = dest + ".part"
    last_err = None
    for cand in candidates:
        try:
            req = urllib.request.Request(cand, headers={"User-Agent": "ysplive-updater"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as f:
                got = 0
                while True:
                    chunk = resp.read(262144)
                    if not chunk:
                        break
                    got += len(chunk)
                    if got > 64 * 1024 * 1024:
                        raise RuntimeError("安装包超过 64MB，已中止")
                    f.write(chunk)
            if os.path.getsize(tmp) < 100000:
                raise RuntimeError("下载的文件过小，可能不是安装包")
            os.replace(tmp, dest)
            last_err = None
            break
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
    if last_err is not None:
        raise RuntimeError("安装包下载失败：%s" % last_err)

    import hashlib
    sha = ""
    with open(dest, "rb") as f:
        h = hashlib.sha256()
        while True:
            b = f.read(1048576)
            if not b:
                break
            h.update(b)
        sha = h.hexdigest()
    expect = (info.get("sha256") or "").lower()
    return {
        "path": dest,
        "size": os.path.getsize(dest),
        "sha256": sha,
        "expect": expect,
        "sha_ok": (sha == expect) if expect else None,
        "version": info.get("latest", ""),
    }


def start_update_watch():
    if UPDATE_CHECK_INTERVAL <= 0:
        return
    def _loop():
        time.sleep(8)
        while True:
            try:
                info = check_update(force=True)
                if info.get("has_update"):
                    print("[更新] 发现新版本 %s（当前 %s）" % (info.get("latest"), info.get("current")), flush=True)
            except Exception:
                pass
            time.sleep(UPDATE_CHECK_INTERVAL)
    threading.Thread(target=_loop, daemon=True).start()



# ---------------------------------------------------------------- EPG（节目单）

EPG_SOURCES = (
    "https://epg.zsdc.eu.org/t.xml.gz",
    "https://epg.pw/xmltv/epg_CN.xml.gz",
)
EPG_TTL = 1800
EPG_KEEP_BEFORE = 3600
EPG_KEEP_AFTER = 12 * 3600

_EPG = {"ts": 0.0, "progs": {}, "source": "", "error": ""}
_EPG_LOCK = threading.Lock()
_EPG_STARTED = False


def epg_file() -> str:
    return os.path.join(DATA_DIR, "epg.json")


def _epg_norm(text: str) -> str:
    return re.sub(r"[^0-9A-Z]+", "", (text or "").upper())


def _epg_ts(raw: str):
    """把 '20261113180000 +0800' 换成 epoch 秒。"""
    try:
        parts = (raw or "").strip().split()
        d = parts[0]
        off = parts[1] if len(parts) > 1 else "+0800"
        dt = datetime.datetime(int(d[0:4]), int(d[4:6]), int(d[6:8]),
                               int(d[8:10]), int(d[10:12]), int(d[12:14]))
        sign = -1 if off.startswith("-") else 1
        dt = dt.replace(tzinfo=datetime.timezone(datetime.timedelta(
            minutes=sign * (int(off[1:3]) * 60 + int(off[3:5] or 0)))))
        return dt.timestamp()
    except Exception:
        return None


EPG_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _epg_download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": EXT_UA})
    buf = bytearray()
    deadline = time.time() + 90
    with EPG_OPENER.open(req, timeout=20) as resp:
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            buf.extend(chunk)
            if len(buf) > 96 * 1024 * 1024 or time.time() > deadline:
                break
    raw = bytes(buf)
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw


def _epg_parse(raw: bytes):
    now = time.time()
    lo = now - EPG_KEEP_BEFORE
    hi = now + EPG_KEEP_AFTER
    progs: dict = {}
    for _event, el in ET.iterparse(io.BytesIO(raw), events=("end",)):
        if el.tag != "programme":
            continue
        ch = el.get("channel") or ""
        start = _epg_ts(el.get("start") or "")
        stop = _epg_ts(el.get("stop") or "")
        node = el.find("title")
        title = (node.text or "").strip() if node is not None else ""
        el.clear()
        if not ch or not title or start is None or stop is None:
            continue
        if stop < lo or start > hi:
            continue
        progs.setdefault(ch, []).append([int(start), int(stop), title])
    for lst in progs.values():
        lst.sort(key=lambda x: x[0])
    return progs


def epg_refresh(force: bool = False) -> bool:
    with _EPG_LOCK:
        if not force and _EPG["progs"] and time.time() - _EPG["ts"] < EPG_TTL:
            return True
    for url in EPG_SOURCES:
        try:
            progs = _epg_parse(_epg_download(url))
            if not progs:
                raise ValueError("节目表为空")
        except Exception as exc:
            with _EPG_LOCK:
                _EPG["error"] = "%s: %s" % (url, exc)
            continue
        with _EPG_LOCK:
            _EPG.update({"ts": time.time(), "progs": progs, "source": url, "error": ""})
        try:
            tmp = epg_file() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"ts": int(time.time()), "source": url, "progs": progs}, fh)
            os.replace(tmp, epg_file())
        except Exception:
            pass
        return True
    return False


def _epg_worker() -> None:
    while True:
        try:
            epg_refresh()
        except Exception:
            pass
        time.sleep(120)


def ensure_epg() -> None:
    global _EPG_STARTED
    with _EPG_LOCK:
        if _EPG_STARTED:
            return
        _EPG_STARTED = True
    try:
        with open(epg_file(), "r", encoding="utf-8") as fh:
            disk = json.load(fh)
        if time.time() - float(disk.get("ts") or 0) < EPG_TTL * 3:
            with _EPG_LOCK:
                _EPG.update({"ts": float(disk.get("ts") or 0),
                             "progs": disk.get("progs") or {},
                             "source": disk.get("source") or "",
                             "error": ""})
    except Exception:
        pass
    threading.Thread(target=_epg_worker, daemon=True).start()


def epg_lookup(tvg_id: str, name: str):
    progs = _EPG["progs"]
    if not progs:
        return None, None
    keys = []
    for raw in (tvg_id or "", name or ""):
        if not raw:
            continue
        keys.append(raw)
        keys.append(_epg_norm(raw))
    if not _epg_norm(tvg_id or ""):
        m = re.match(r"(CCTV[0-9]+[+]?)", _epg_norm(name or ""))
        if m:
            keys.append(m.group(1))
    lst = None
    for key in keys:
        if key and key in progs:
            lst = progs[key]
            break
    if not lst:
        return None, None
    now = time.time()
    cur = nxt = None
    for start, stop, title in lst:
        if start <= now < stop:
            cur = (start, stop, title)
            continue
        if start > now:
            nxt = (start, stop, title)
            break

    def fmt(item):
        if not item:
            return None
        return {"title": item[2],
                "start": time.strftime("%H:%M", time.localtime(item[0])),
                "stop": time.strftime("%H:%M", time.localtime(item[1]))}

    return fmt(cur), fmt(nxt)


# ---------------------------------------------------------------- 配置读写

def config_path() -> str:
    return os.path.join(DATA_DIR, "ui-config.json")


def _clean_text(value, limit: int, default: str = "") -> str:
    if not isinstance(value, str):
        return default
    value = value.replace("\r", " ").replace("\n", " ").strip()
    return value[:limit]


def _clean_url(value) -> str:
    url = _clean_text(value, 2048)
    if not url:
        return ""
    if not re.match(r"^https?://", url, re.I):
        return ""
    return url


def normalize_config(raw) -> dict:
    """把外部输入收敛成结构合法、长度可控的配置。"""
    cfg = {
        "site": dict(DEFAULT_CONFIG["site"]),
        "overrides": {},
        "hidden": [],
        "custom": [],
    }
    if not isinstance(raw, dict):
        return cfg

    site = raw.get("site")
    if isinstance(site, dict):
        cfg["site"]["title"] = _clean_text(site.get("title"), 40, DEFAULT_CONFIG["site"]["title"]) \
            or DEFAULT_CONFIG["site"]["title"]
        cfg["site"]["notice"] = _clean_text(site.get("notice"), 120, "") 

    overrides = raw.get("overrides")
    if isinstance(overrides, dict):
        for slug, item in list(overrides.items())[:200]:
            if not isinstance(slug, str) or not re.match(r"^[a-zA-Z0-9_\-]{1,40}$", slug):
                continue
            if not isinstance(item, dict):
                continue
            entry = {}
            name = _clean_text(item.get("name"), 40)
            group = _clean_text(item.get("group"), 20)
            url = _clean_url(item.get("url"))
            if name:
                entry["name"] = name
            if group:
                entry["group"] = group
            if url:
                entry["url"] = url
            if entry:
                cfg["overrides"][slug] = entry

    hidden = raw.get("hidden")
    if isinstance(hidden, list):
        for slug in hidden[:200]:
            if isinstance(slug, str) and re.match(r"^[a-zA-Z0-9_\-]{1,40}$", slug):
                cfg["hidden"].append(slug)

    custom = raw.get("custom")
    if isinstance(custom, list):
        seen = set()
        for item in custom[:200]:
            if not isinstance(item, dict):
                continue
            url = _clean_url(item.get("url"))
            if not url:
                continue
            cid = _clean_text(item.get("id"), 40)
            if not re.match(r"^[a-zA-Z0-9_\-]{1,40}$", cid) or cid in seen:
                cid = "c%d" % (len(seen) + 1)
            seen.add(cid)
            cfg["custom"].append({
                "id": cid,
                "name": _clean_text(item.get("name"), 40) or "自定义频道",
                "group": _clean_text(item.get("group"), 20) or "自定义",
                "url": url,
                "logo": _clean_url(item.get("logo")),
            })

    return cfg


def load_config() -> dict:
    path = config_path()
    if not os.path.isfile(path):
        return normalize_config(DEFAULT_CONFIG)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return normalize_config(json.load(f))
    except Exception:
        return normalize_config(DEFAULT_CONFIG)


def save_config(cfg: dict) -> None:
    path = config_path()
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ---------------------------------------------------------------- 引擎交互

def engine_get(path: str, host_header: str, timeout: float = 15.0, extra=None):
    conn = http.client.HTTPConnection("127.0.0.1", ENGINE_PORT, timeout=timeout)
    headers = {"Host": host_header or "127.0.0.1:%d" % UI_PORT}
    if extra:
        headers.update(extra)
    conn.request("GET", path, headers=headers)
    resp = conn.getresponse()
    body = resp.read()
    return resp.status, resp.getheader("Content-Type") or "", body


def engine_json(path: str, host_header: str, timeout: float = 10.0):
    status, _ctype, body = engine_get(path, host_header, timeout)
    if status != 200:
        return None
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except Exception:
        return None


ATTR_RE = re.compile(r'([a-zA-Z0-9\-]+)="([^"]*)"')


def parse_playlist(text: str):
    """把 m3u 拆成 [(attrs_dict, display_name, url)]，忽略非频道行。"""
    entries = []
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    pending = None
    for ln in lines:
        if ln.startswith("#EXTINF"):
            payload = ln[ln.find(":") + 1:] if ":" in ln else ""
            attrs = dict(ATTR_RE.findall(payload))
            name = payload.rsplit(",", 1)[-1].strip() if "," in payload else ""
            pending = (attrs, name)
        elif ln.startswith("#"):
            continue
        elif pending is not None:
            entries.append((pending[0], pending[1], ln))
            pending = None
    return entries


def slug_of_url(url: str) -> str:
    try:
        path = urllib.parse.urlsplit(url).path
    except Exception:
        return ""
    name = os.path.basename(path)
    if name.endswith(".m3u8"):
        name = name[:-5]
    return name


def load_channels(host_header: str):
    """读取内置频道（来自引擎订阅单），合并覆盖项与自定义频道。"""
    status, _ctype, body = engine_get("/all.m3u", host_header, 12.0)
    builtin = []
    if status == 200:
        text = body.decode("utf-8", "replace")
        for attrs, name, url in parse_playlist(text):
            slug = slug_of_url(url)
            if not slug:
                continue
            builtin.append({
                "slug": slug,
                "name": name or attrs.get("tvg-name") or slug,
                "group": attrs.get("group-title") or "其他",
                "logo": attrs.get("tvg-logo") or "",
                "tvg_id": attrs.get("tvg-id") or "",
                "url": url,
                "catchup": "catchup" in attrs,
            })
    cfg = load_config()
    overrides = cfg["overrides"]
    hidden = set(cfg["hidden"])
    for ch in builtin:
        ov = overrides.get(ch["slug"]) or {}
        ch["orig_name"] = ch["name"]
        ch["orig_group"] = ch["group"]
        ch["custom_url"] = ov.get("url", "")
        if ov.get("name"):
            ch["name"] = ov["name"]
        if ov.get("group"):
            ch["group"] = ov["group"]
        ch["hidden"] = ch["slug"] in hidden
        ch["edited"] = bool(ov)
    return builtin, cfg


def _marked_url(url: str, line: str) -> str:
    """给内置频道地址加上线路标记；外部自定义地址原样返回。"""
    if not url:
        return url
    sep = "&" if "?" in url else "?"
    return url + sep + "line=" + line


def build_merged_playlist(host_header: str, builtin, cfg, line: str = "", dual: bool = False) -> str:
    proto = "http"
    head = None
    status, _ctype, body = engine_get("/all.m3u", host_header, 12.0)
    if status == 200:
        text = body.decode("utf-8", "replace")
        for ln in text.splitlines():
            if ln.strip().startswith("#EXTM3U"):
                head = ln.strip()
                break
        entries = parse_playlist(text)
    else:
        entries = []

    if not head:
        head = ('#EXTM3U url-tvg="https://epg.zsdc.eu.org/t.xml.gz" '
                'x-tvg-url="https://epg.zsdc.eu.org/t.xml.gz"')

    overrides = cfg["overrides"]
    hidden = set(cfg["hidden"])
    out = [head]

    for attrs, name, url in entries:
        slug = slug_of_url(url)
        if slug and slug in hidden:
            continue
        ov = overrides.get(slug) or {}
        ch_name = ov.get("name") or name or attrs.get("tvg-name") or slug
        ch_group = ov.get("group") or attrs.get("group-title") or "其他"
        play_url = ov.get("url") or url
        internal = not ov.get("url") and bool(slug)

        def emit(channel_name, channel_url, with_catchup):
            ln = '#EXTINF:-1 tvg-id="%s" tvg-name="%s" tvg-logo="%s" group-title="%s"' % (
                attrs.get("tvg-id", ""), channel_name, attrs.get("tvg-logo", ""), ch_group)
            if with_catchup and attrs.get("catchup"):
                ln += ' catchup="append" catchup-days="%s" catchup-source="%s"' % (
                    attrs.get("catchup-days", "7"), attrs.get("catchup-source", ""))
            out.append(ln + "," + channel_name)
            out.append(channel_url)

        if internal and line == "bk":
            # 整份订阅强制走备用线路：7 天回看依赖主线路，这里不带 catchup
            emit(ch_name, _marked_url(play_url, "bk"), False)
        elif internal and dual:
            # 主 + 备两条：播放器卡在第一条时手动切第二条，不用改订阅
            emit(ch_name, play_url, True)
            emit(ch_name + "·备", _marked_url(play_url, "bk"), False)
        else:
            emit(ch_name, play_url, True)

    for ch in cfg["custom"]:
        out.append('#EXTINF:-1 tvg-name="%s" tvg-logo="%s" group-title="%s",%s' % (
            ch["name"], ch.get("logo", ""), ch["group"], ch["name"]))
        out.append(ch["url"])

    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- 工具

def b64e(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def b64d(text: str) -> str:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad).decode("utf-8", "replace")


def client_scope(addr: str) -> str:
    """判断访问来源：lan / ipv6 / public。

    lan  —— IPv4 内网（10、172.16、192.168、127、169.254）或 IPv6 回环/链路本地/ULA(fc00::/7)
    ipv6 —— 公网 IPv6 全球单播（家宽 IPv6 直连，例如 2409:...），同样允许改配置
    public —— 其余（公网 IPv4），只读
    """
    try:
        ip = ipaddress.ip_address((addr or "").split("%")[0])
    except ValueError:
        return "public"
    if ip.version == 4:
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return "lan"
        return "public"
    # IPv6：回环、链路本地、ULA 视为内网；全球单播（含 DDNS 域名解析出的家宽地址）放行修改
    if ip.is_loopback or ip.is_link_local or ip.is_private:
        return "lan"
    if ip.is_global:
        return "ipv6"
    return "public"


def is_private_addr(addr: str) -> bool:
    return client_scope(addr) in ("lan", "ipv6")


def read_web(name: str) -> bytes:
    path = os.path.join(WEB_DIR, name)
    with open(path, "rb") as f:
        return f.read()


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "ysplive-ui"
    protocol_version = "HTTP/1.1"

    # 关掉默认的 stderr 访问日志噪音，只保留错误
    def log_message(self, fmt, *args):
        return

    def _client_ip(self) -> str:
        return self.client_address[0]

    def _send(self, status: int, body: bytes, ctype: str, extra=None, head_only=False):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        _no_store = (ctype.startswith("application/json") or ctype.startswith("text/")
                     or "javascript" in ctype or "css" in ctype)
        self.send_header("Cache-Control", "no-store" if _no_store else "no-cache")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if not head_only:
            self.wfile.write(body)

    def _send_json(self, obj, status=200, head_only=False):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(status, data, "application/json; charset=utf-8", head_only=head_only)

    def do_HEAD(self):
        self.do_GET(head_only=True)

    # ------------------------------------------------------------ GET

    def do_GET(self, head_only=False):
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        try:
            if path in ("/", "/index.html"):
                html = read_web("index.html")
                self._send(200, html, "text/html; charset=utf-8", head_only=head_only)
                return

            if path == "/static/hls.js":
                data = read_web("hls.min.js")
                self._send(200, data, "application/javascript; charset=utf-8", head_only=head_only)
                return

            if path == "/static/app.css":
                data = read_web("app.css")
                self._send(200, data, "text/css; charset=utf-8", head_only=head_only)
                return

            if path == "/static/app.js":
                data = read_web("app.js")
                self._send(200, data, "application/javascript; charset=utf-8", head_only=head_only)
                return

            if path == "/play":
                # /play?ch=<slug> 与首页同一个界面，带参数会自动打开播放器
                html = read_web("index.html")
                self._send(200, html, "text/html; charset=utf-8", head_only=head_only)
                return

            if path == "/api/state":
                self.handle_state(head_only)
                return

            if path == "/api/config":
                self._send_json(load_config(), head_only=head_only)
                return

            if path == "/api/update":
                force = (query.get("force") or [""])[0] in ("1", "true", "yes")
                self._send_json(check_update(force=force), head_only=head_only)
                return

            if path == "/api/diag":
                host = self.headers.get("Host", "")
                status, ctype, body = engine_get("/diag", host, 15.0)
                self._send(status, body, ctype or "text/plain; charset=utf-8", head_only=head_only)
                return

            if path == "/all.m3u":
                host = self.headers.get("Host", "")
                builtin, cfg = load_channels(host)
                want_line = (query.get("line", [""])[0] or "").strip().lower()
                if want_line not in ("bk", "backup", "jce", "main"):
                    want_line = ""
                want_dual = (query.get("dual", query.get("bak", [""]))[0] or "").strip().lower()
                want_dual = want_dual in ("1", "true", "yes", "on")
                text = build_merged_playlist(host, builtin, cfg, line=want_line, dual=want_dual)
                self._send(200, text.encode("utf-8"), "application/vnd.apple.mpegurl",
                           extra={"Access-Control-Allow-Origin": "*"}, head_only=head_only)
                return

            if path in ("/check", "/check.html"):
                html = read_web("check.html")
                self._send(200, html, "text/html; charset=utf-8", head_only=head_only)
                return

            if path == "/api/play.m3u8":
                self.handle_play_m3u8(query, head_only)
                return

            if path == "/ext":
                self.handle_ext(query, head_only)
                return

            if path == "/favicon.ico":
                self._send(204, b"", "image/x-icon", head_only=head_only)
                return

            # 其余（/<slug>.m3u8、/proxy.ts、/health …）全部转发给内部引擎
            self.proxy_to_engine("GET", head_only)
        except (BrokenPipeError, ConnectionResetError):
            return
        except FileNotFoundError:
            self._send(404, b"not found\n", "text/plain; charset=utf-8", head_only=head_only)
        except Exception as exc:  # noqa: BLE001
            try:
                self._send_json({"error": str(exc)}, 500, head_only=head_only)
            except Exception:
                pass

    # ------------------------------------------------------------ 状态

    def handle_state(self, head_only=False):
        host = self.headers.get("Host", "")
        health = engine_json("/health", host, 8.0) or {}
        builtin, cfg = load_channels(host)
        groups = []
        for ch in builtin:
            if ch["group"] not in groups:
                groups.append(ch["group"])
        for ch in cfg["custom"]:
            if ch["group"] not in groups:
                groups.append(ch["group"])
        ensure_epg()
        for ch in builtin:
            cur, nxt = epg_lookup(ch.get("tvg_id") or "", ch.get("name") or "")
            ch["now"] = cur
            ch["next"] = nxt
        epg_meta = {"ok": bool(_EPG["progs"]), "at": int(_EPG["ts"] or 0),
                    "source": _EPG["source"], "error": _EPG["error"]}
        payload = {
            "ok": bool(health.get("ok")),
            "engine": health,
            "site": cfg["site"],
            "builtin": builtin,
            "custom": cfg["custom"],
            "groups": groups,
            "counts": {
                "builtin": len(builtin),
                "visible": len([c for c in builtin if not c["hidden"]]) + len(cfg["custom"]),
                "custom": len(cfg["custom"]),
                "hidden": len(cfg["hidden"]),
            },
            "ports": {"ui": UI_PORT, "engine": ENGINE_PORT},
            "writable": is_private_addr(self._client_ip()),
            "scope": client_scope(self._client_ip()),
            "epg": epg_meta,
            "version": current_version(),
            "update": cached_update_info(),
        }
        self._send_json(payload, head_only=head_only)

    # ------------------------------------------------------------ 保存配置

    def do_PUT(self):
        self.handle_config_write()

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path == "/api/config":
            self.handle_config_write()
        elif path in ("/api/update/download", "/api/update/upgrade"):
            if not is_private_addr(self._client_ip()):
                self._send_json({"error": "仅内网 / IPv6 访问可下载升级包"}, 403)
                return
            try:
                self._send_json(download_update())
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc)}, 500)
        else:
            self._send_json({"error": "unsupported"}, 404)

    def handle_config_write(self):
        if not is_private_addr(self._client_ip()):
            self._send_json({"error": "不允许修改配置：仅内网 / IPv6 访问可写（当前来源是公网 IPv4）"}, 403)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_CFG_BYTES:
            self._send_json({"error": "请求体大小不合法"}, 400)
            return
        try:
            raw = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json({"error": "JSON 解析失败"}, 400)
            return

        cfg = normalize_config(raw)
        with CFG_LOCK:
            try:
                save_config(cfg)
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": "保存失败：%s" % exc}, 500)
                return
        self._send_json({"ok": True, "config": cfg})

    # ------------------------------------------------------------ 转发

    def proxy_to_engine(self, method: str, head_only=False):
        host = self.headers.get("Host", "")
        conn = http.client.HTTPConnection("127.0.0.1", ENGINE_PORT, timeout=30)
        fwd = {"Host": host or "127.0.0.1:%d" % UI_PORT}
        for key in ("Range", "Accept", "User-Agent", "Referer", "Origin",
                    "If-None-Match", "If-Modified-Since",
                    "X-Forwarded-Proto", "X-Forwarded-For", "X-Forwarded-Host"):
            value = self.headers.get(key)
            if value:
                fwd[key] = value
        try:
            conn.request(method, self.path, headers=fwd)
            resp = conn.getresponse()
        except Exception as exc:  # noqa: BLE001
            self._send_json({"error": "引擎不可用：%s" % exc}, 502, head_only=head_only)
            return

        pass_keys = ("content-type", "content-range", "accept-ranges",
                     "content-length", "location", "cache-control", "x-line")
        self.send_response(resp.status)
        for key, value in resp.getheaders():
            if key.lower() in pass_keys:
                self.send_header(key, value)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Connection", "close")
        self.end_headers()

        if head_only:
            return
        try:
            while True:
                try:
                    chunk = resp.read1(16384)
                except AttributeError:
                    chunk = resp.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        finally:
            conn.close()

    # ------------------------------------------------------------ 播放代理

    def scheme(self) -> str:
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        return proto if proto in ("http", "https") else "http"

    def handle_play_m3u8(self, query, head_only=False):
        """把内置频道的播放地址转成同源地址。

        直连模式下分片指向央视 CDN（依赖 CDN 的 CORS）；
        proxy=1 时把每个分片改写成 /proxy.ts，由引擎带正确请求头转发，彻底绕开跨域。
        """
        slug = (query.get("ch") or [""])[0]
        if not re.match(r"^[a-zA-Z0-9_\-]{1,40}$", slug):
            self._send(400, b"bad channel\n", "text/plain; charset=utf-8", head_only=head_only)
            return
        use_proxy = (query.get("proxy") or ["0"])[0] == "1"
        host = self.headers.get("Host", "")
        status, ctype, body = engine_get("/" + slug + ".m3u8", host, 20.0)
        if status != 200:
            self._send(status, body, ctype or "text/plain; charset=utf-8", head_only=head_only)
            return

        text = body.decode("utf-8", "replace")
        if use_proxy:
            origin = "%s://%s" % (self.scheme(), host)
            out = []
            for line in text.splitlines():
                stripped = line.strip()
                if stripped and not stripped.startswith("#") and re.match(r"^https?://", stripped, re.I):
                    out.append("%s/proxy.ts?=%s" % (origin, b64e(stripped)))
                else:
                    out.append(line)
            text = "\n".join(out) + "\n"

        self._send(200, text.encode("utf-8"), "application/vnd.apple.mpegurl",
                   extra={"Access-Control-Allow-Origin": "*"}, head_only=head_only)

    # ------------------------------------------------------------ 外链代理

    def handle_ext(self, query, head_only=False):
        raw = (query.get("u") or [""])[0]
        try:
            target = b64d(raw)
        except Exception:
            self._send(400, b"bad url\n", "text/plain; charset=utf-8", head_only=head_only)
            return
        if not re.match(r"^https?://", target, re.I):
            self._send(400, b"only http(s) allowed\n", "text/plain; charset=utf-8", head_only=head_only)
            return

        req = urllib.request.Request(target, headers={
            "User-Agent": EXT_UA,
            "Accept": "application/vnd.apple.mpegurl,mpegurl,*/*",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                ctype = (resp.headers.get("Content-Type") or "").lower()
                final = resp.geturl()
                data = resp.read()
        except Exception as exc:  # noqa: BLE001
            self._send(502, ("抓取失败：%s\n" % exc).encode("utf-8"),
                       "text/plain; charset=utf-8", head_only=head_only)
            return

        is_playlist = ("mpegurl" in ctype) or ("mpegurl" in final.lower())
        if not is_playlist:
            head = data[:120].lstrip()
            if head.startswith(b"#EXTM3U"):
                is_playlist = True

        if is_playlist:
            text = data.decode("utf-8", "replace")
            self._send(200, self.rewrite_external(text, final).encode("utf-8"),
                       "application/vnd.apple.mpegurl",
                       extra={"Access-Control-Allow-Origin": "*"}, head_only=head_only)
            return

        self._send(200, data, self.headers.get("Accept") and (ctype or "application/octet-stream") or "application/octet-stream",
                   extra={"Access-Control-Allow-Origin": "*"}, head_only=head_only)

    def rewrite_external(self, text: str, base: str) -> str:
        out = []
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                out.append(line)
                continue
            if stripped.startswith("#"):
                # 处理加密 key / map 里的 URI
                def repl(match):
                    abs_url = urllib.parse.urljoin(base, match.group(1))
                    return 'URI="%s"' % ("/ext?u=" + b64e(abs_url))
                out.append(re.sub(r'URI="([^"]+)"', repl, line))
                continue
            abs_url = urllib.parse.urljoin(base, stripped)
            if abs_url.startswith(("http://", "https://")):
                out.append("/ext?u=" + b64e(abs_url))
            else:
                out.append(stripped)
        return "\n".join(out) + "\n"


# ---------------------------------------------------------------- 启动

class DualStackServer(ThreadingHTTPServer):
    """同时接受 IPv4 与 IPv6：绑定 :: 并关闭 IPV6_V6ONLY，IPv4 走映射地址。"""

    daemon_threads = True
    allow_reuse_address = True
    address_family = socket.AF_INET6

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


def main():
    global DATA_DIR, ENGINE_PORT, UI_PORT, CONFIG_PATH

    ap = argparse.ArgumentParser(description="ysplive 管理界面")
    ap.add_argument("--port", type=int, default=8767, help="界面/订阅端口")
    ap.add_argument("--engine-port", type=int, default=8788, help="内部引擎端口")
    ap.add_argument("--data", default="./data", help="配置目录")
    args = ap.parse_args()

    UI_PORT = args.port
    ENGINE_PORT = args.engine_port
    DATA_DIR = os.path.abspath(args.data)
    CONFIG_PATH = config_path()
    os.makedirs(DATA_DIR, exist_ok=True)

    ensure_epg()

    if not os.path.isfile(CONFIG_PATH):
        try:
            save_config(normalize_config(DEFAULT_CONFIG))
        except Exception:
            pass

    try:
        srv = DualStackServer(("::", UI_PORT), Handler)
        dual = True
    except OSError as exc:
        print("[ui] IPv6 双栈绑定失败（%s），回退 IPv4" % exc, flush=True)
        srv = ThreadingHTTPServer(("0.0.0.0", UI_PORT), Handler)
        dual = False

    print("[ui] ysplive 管理界面已启动: 端口 %d（%s）  引擎 127.0.0.1:%d" %
          (UI_PORT, "IPv4+IPv6 双栈" if dual else "仅 IPv4", ENGINE_PORT), flush=True)
    start_update_watch()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
