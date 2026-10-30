import base64
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
import uuid
from datetime import date, datetime, timezone
from functools import lru_cache
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).parent
WEB_DIR = ROOT / "web"
DATA_DIR = Path(os.environ.get("DATA_DIR") or ROOT / "data")
STORE = DATA_DIR / "store.json"
SEED = ROOT / "data" / "seed.json"
HISTORY = DATA_DIR / "history.json"
CHANGELOG = DATA_DIR / "changelog.jsonl"
JORDAN = DATA_DIR / "jordan.json"
USERS = DATA_DIR / "users.json"
SECRET_FILE = DATA_DIR / ".session_secret"
SESSION_HOURS = 12
ROLES = {"viewer": 0, "editor": 1, "owner": 2}
USERNAME_RE = re.compile(r"^[a-z0-9._-]{1,40}$")
COOKIE = "ts_session"
FAILED_LOGINS: dict = {}
MAX_BODY = 100_000
MAX_JORDAN_BODY = 400_000
BACKUPS_KEPT = 30
HISTORY_KEPT = 400
STATUSES = ("Red", "Amber", "Green", "Done")
LOCK = threading.Lock()
FAILED_KEYS: dict = {}

# Pages that need a sign-in once accounts exist; the login page and stylesheet stay public.
STATIC_FILES = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js"}
PUBLIC_FILES = {"/login": "login.html", "/login.js": "login.js", "/styles.css": "styles.css"}
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8"}

# Writable fields per collection. Anything else in a request is dropped.
FIELDS = {
    "items": ("title", "pillar", "area", "owner", "status", "due", "started", "completed", "region", "notes", "link", "priority", "blocker", "internal", "milestone", "thisWeek"),
    "milestones": ("title", "date", "pillar", "owner", "status", "notes", "itemId"),
    "wins": ("title", "detail", "impact", "date", "pillar", "unit"),
    "kpis": ("label", "value", "target", "unit", "note", "pillar", "auto"),
}
REQUIRED = {"items": "title", "milestones": "title", "wins": "title", "kpis": "label"}
TITLE_OF = {"items": "title", "milestones": "title", "wins": "title", "kpis": "label"}
BOOL_FIELDS = {"priority", "blocker", "internal", "milestone", "thisWeek"}
NUM_FIELDS = {"value", "target"}
DATE_FIELDS = {"due", "date", "started", "completed"}
ENUMS = {
    "items": {"status": set(STATUSES)},
    "milestones": {"status": {"Upcoming", "At risk", "Done"}},
    "kpis": {"auto": {"", "areas", "headcount", "wins", "milestones"}},
}


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------- storage ----------
def load_store() -> dict:
    if not STORE.exists():
        shutil.copy(SEED, STORE)
    return json.loads(STORE.read_text(encoding="utf-8"))


def backup_daily() -> None:
    target = Path(os.environ.get("BACKUP_DIR") or DATA_DIR / "backups")
    try:
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy(STORE, target / f"store-{date.today().isoformat()}.json")
        for old in sorted(target.glob("store-*.json"))[:-BACKUPS_KEPT]:
            old.unlink()
    except OSError as exc:
        print(f"Backup skipped: {exc}")


def load_history() -> list:
    return json.loads(HISTORY.read_text(encoding="utf-8")) if HISTORY.exists() else []


def snapshot_of(data: dict) -> dict:
    items = data["items"]
    today = date.today().isoformat()

    def counts(rows: list) -> dict:
        return {s: sum(1 for i in rows if i["status"] == s) for s in STATUSES}

    return {
        "date": today, "total": len(items), "status": counts(items),
        "pillars": {p["id"]: counts([i for i in items if i["pillar"] == p["id"]]) for p in data["pillars"]},
        "priorities": sum(1 for i in items if i.get("priority")),
        "overdue": sum(1 for i in items if i.get("due") and i["due"] < today and i["status"] in ("Red", "Amber")),
        "wins": len(data["wins"]),
        "milestonesDone": sum(1 for m in data["milestones"] if m["status"] == "Done") + sum(1 for i in items if i.get("milestone") and i["status"] == "Done"),
        "milestonesTotal": len(data["milestones"]) + sum(1 for i in items if i.get("milestone")),
    }


def take_snapshot(data: dict) -> None:
    snap = snapshot_of(data)
    history = [h for h in load_history() if h["date"] != snap["date"]] + [snap]
    history.sort(key=lambda h: h["date"])
    HISTORY.write_text(json.dumps(history[-HISTORY_KEPT:], indent=1), encoding="utf-8")


def save_store(data: dict) -> None:
    if STORE.exists():
        shutil.copy(STORE, STORE.with_suffix(".bak.json"))
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    os.replace(tmp, STORE)
    backup_daily()
    take_snapshot(data)


def short(value) -> str:
    if isinstance(value, bool):
        return "yes" if value else "no"
    return str(value if value is not None else "")[:200]


def log_change(actor: str, action: str, coll: str, rid: str, title: str, changes: dict | None = None) -> None:
    entry = {"ts": now_iso(), "actor": actor, "action": action, "collection": coll, "id": rid, "title": short(title)}
    if changes:
        entry["changes"] = {k: [short(a), short(b)] for k, (a, b) in changes.items()}
    with CHANGELOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def read_changelog(limit: int) -> list:
    if not CHANGELOG.exists():
        return []
    lines = CHANGELOG.read_text(encoding="utf-8").splitlines()[-limit:]
    return [json.loads(line) for line in reversed(lines) if line.strip()]


# ---------- Jordan's private workspace: separate file, never part of stats, history or the activity log ----------
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
AUDIENCES = ("alex", "team")


def load_jordan() -> dict:
    if not JORDAN.exists():
        return {"todos": [], "updates": []}
    return json.loads(JORDAN.read_text(encoding="utf-8"))


def clean_jordan(raw: dict) -> dict:
    def text(v, limit):
        return v.strip()[:limit] if isinstance(v, str) else ""

    def day(v):
        return v if isinstance(v, str) and DATE_RE.match(v) else ""

    todos, updates = [], []
    for t in (raw.get("todos") if isinstance(raw.get("todos"), list) else [])[:300]:
        if isinstance(t, dict) and text(t.get("text"), 300):
            todos.append({"id": text(t.get("id"), 20) or uuid.uuid4().hex[:8], "text": text(t.get("text"), 300), "due": day(t.get("due")),
                          "done": bool(t.get("done")), "star": bool(t.get("star")), "created": day(t.get("created")), "doneAt": day(t.get("doneAt"))})
    for u in (raw.get("updates") if isinstance(raw.get("updates"), list) else [])[:200]:
        if isinstance(u, dict) and text(u.get("text"), 1500) and u.get("audience") in AUDIENCES:
            updates.append({"id": text(u.get("id"), 20) or uuid.uuid4().hex[:8], "audience": u["audience"], "text": text(u.get("text"), 1500),
                            "date": day(u.get("date")), "sent": bool(u.get("sent"))})
    return {"todos": todos, "updates": updates}


def save_jordan(raw: dict) -> dict:
    data = clean_jordan(raw)
    with LOCK:
        if JORDAN.exists():
            shutil.copy(JORDAN, JORDAN.with_suffix(".bak.json"))
        tmp = JORDAN.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        os.replace(tmp, JORDAN)
    return data


# ---------- sign-in: accounts in data/users.json, signed session cookie ----------
# With no accounts the site behaves as before (edit key or local-only editing). Once an account exists, everything needs a sign-in.
def load_users() -> dict:
    try:
        return json.loads(USERS.read_text(encoding="utf-8")).get("users", {})
    except (OSError, ValueError):
        return {}


def save_users(users: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = USERS.with_suffix(".tmp")
    tmp.write_text(json.dumps({"users": users}, indent=1), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, USERS)


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
        return hmac.compare_digest(hash_password(password, bytes.fromhex(salt)).split("$")[2], digest)
    except ValueError:
        return False


DUMMY_HASH = hash_password("not-a-real-password")  # lets unknown usernames cost the same time as real ones


@lru_cache(maxsize=1)
def session_secret() -> bytes:
    env = os.environ.get("SESSION_SECRET", "")
    if env:
        return env.encode("utf-8")
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_hex(32), encoding="utf-8")
        os.chmod(SECRET_FILE, 0o600)
    return SECRET_FILE.read_text(encoding="utf-8").strip().encode("utf-8")


def sign(payload: str) -> str:
    return hmac.new(session_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def make_token(username: str) -> str:
    payload = f"{username}|{int(time.time()) + SESSION_HOURS * 3600}"
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii") + "." + sign(payload)


def token_user(token: str) -> str | None:
    try:
        raw, sig = token.split(".", 1)
        payload = base64.urlsafe_b64decode(raw.encode("ascii")).decode("utf-8")
        user, expires = payload.rsplit("|", 1)
        if hmac.compare_digest(sig, sign(payload)) and int(expires) > time.time():
            return user
    except (ValueError, UnicodeError):
        pass
    return None


def manage_users(args: list) -> None:
    """python server.py add-user NAME [--role viewer|editor|owner] [--name "Display name"] | remove-user NAME | list-users"""
    users = load_users()
    cmd = args[0]
    if cmd == "list-users":
        for name, acct in sorted(users.items()):
            print(f"{name:20} {acct['role']:8} {acct.get('name', '')}")
    elif cmd == "remove-user" and len(args) > 1:
        if users.pop(args[1].lower(), None) is None:
            sys.exit("No such user.")
        save_users(users)
        print("Removed.")
    elif cmd == "add-user" and len(args) > 1:
        name, role, display = args[1].lower(), "viewer", args[1]
        rest = args[2:]
        while rest:
            flag, value = rest[0], (rest[1] if len(rest) > 1 else "")
            if flag == "--role":
                role = value
            elif flag == "--name":
                display = value
            else:
                sys.exit(f"Unknown option {flag}")
            rest = rest[2:]
        if not USERNAME_RE.match(name):
            sys.exit("Username: 1-40 characters, letters, numbers, dot, dash or underscore.")
        if role not in ROLES:
            sys.exit("Role must be viewer, editor or owner.")
        password = getpass.getpass("Password (10+ characters): ")
        if len(password) < 10 or password != getpass.getpass("Repeat password: "):
            sys.exit("Passwords must match and be at least 10 characters.")
        users[name] = {"hash": hash_password(password), "role": role, "name": display[:60]}
        save_users(users)
        print(f"Saved {name} as {role}.")
    else:
        sys.exit(manage_users.__doc__)


def strip_internal(data: dict) -> dict:
    """Executive view: drop items flagged internal and the free-text detail."""
    out = dict(data)
    out["items"] = [{k: v for k, v in i.items() if k not in ("notes", "updates")} for i in data["items"] if not i.get("internal")]
    return out


# ---------- validation and mutations ----------
def clean_record(coll: str, raw: dict, pillar_ids: set) -> dict:
    out: dict = {}
    for field in FIELDS[coll]:
        if field not in raw:
            continue
        value = raw[field]
        if field in BOOL_FIELDS:
            out[field] = bool(value)
        elif field in NUM_FIELDS:
            if value in (None, ""):
                out[field] = None
            else:
                try:
                    out[field] = float(value) if "." in str(value) else int(value)
                except ValueError:
                    raise ValueError(f"{field} must be a number")
        else:
            text = str(value or "").strip()[:2000]
            if field in DATE_FIELDS and text and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
                raise ValueError(f"{field} must be YYYY-MM-DD")
            if field == "pillar" and text and text not in pillar_ids:
                raise ValueError("Unknown pillar")
            if field == "link" and text and not re.match(r"https?://", text):
                raise ValueError("link must start with http:// or https://")
            allowed = ENUMS.get(coll, {}).get(field)
            if allowed and text not in allowed:
                raise ValueError(f"{field} must be one of {sorted(allowed)}")
            out[field] = text
    return out


def upsert(coll: str, body: dict, actor: str) -> dict:
    with LOCK:
        data = load_store()
        pillar_ids = {p["id"] for p in data["pillars"]}
        record = clean_record(coll, body, pillar_ids)
        if coll == "milestones" and record.get("itemId") and not any(i["id"] == record["itemId"] for i in data["items"]):
            raise ValueError("Linked item not found")
        rid = str(body.get("id", "")).strip()
        existing = next((r for r in data[coll] if r["id"] == rid), None) if rid else None
        before = json.loads(json.dumps(existing)) if existing else None
        if existing:
            existing.update(record)
            result = existing
        else:
            result = {"id": uuid.uuid4().hex[:8], **record}
            if coll == "items":
                result["updates"] = []
            data[coll].insert(0, result)
        if coll == "items":
            if result.get("status") == "Done" and not result.get("completed"):
                result["completed"] = date.today().isoformat()
            result["updatedAt"] = now_iso()
        if not result.get(REQUIRED[coll]):
            raise ValueError(f"{REQUIRED[coll]} is required")
        save_store(data)
        title = result.get(TITLE_OF[coll], "")
        if before is None:
            log_change(actor, "created", coll, result["id"], title)
        else:
            skip = {"updatedAt", "updates"}
            changes = {k: (before.get(k), result.get(k)) for k in result if k not in skip and before.get(k) != result.get(k)}
            if changes:
                log_change(actor, "updated", coll, result["id"], title, changes)
        return result


def delete(coll: str, rid: str, actor: str) -> None:
    with LOCK:
        data = load_store()
        target = next((r for r in data[coll] if r["id"] == rid), None)
        if not target:
            raise KeyError("Not found")
        data[coll] = [r for r in data[coll] if r["id"] != rid]
        if coll == "items":
            for m in data["milestones"]:
                if m.get("itemId") == rid:
                    m["itemId"] = ""
        save_store(data)
        log_change(actor, "deleted", coll, rid, target.get(TITLE_OF[coll], ""))


def update_pillar(pid: str, body: dict, actor: str) -> dict:
    with LOCK:
        data = load_store()
        pillar = next((p for p in data["pillars"] if p["id"] == pid), None)
        if not pillar:
            raise KeyError("Not found")
        changes = {}
        for field in ("name", "leader", "focus"):
            if field in body:
                text = str(body[field] or "").strip()[:2000]
                if field == "name" and not text:
                    raise ValueError("name is required")
                if pillar.get(field) != text:
                    changes[field] = (pillar.get(field), text)
                pillar[field] = text
        save_store(data)
        if changes:
            log_change(actor, "updated", "pillars", pid, f"{pid} {pillar['name']}", changes)
        return pillar


def add_update(item_id: str, body: dict, actor: str) -> dict:
    text = str(body.get("text", "")).strip()[:1000]
    if not text:
        raise ValueError("text is required")
    with LOCK:
        data = load_store()
        item = next((i for i in data["items"] if i["id"] == item_id), None)
        if not item:
            raise KeyError("Not found")
        item.setdefault("updates", []).insert(0, {"date": date.today().isoformat(), "text": text, "by": actor})
        item["updatedAt"] = now_iso()
        save_store(data)
        log_change(actor, "progress update", "items", item_id, item["title"], {"update": ("", text)})
        return item


def clear_week(actor: str) -> dict:
    with LOCK:
        data = load_store()
        cleared = 0
        for item in data["items"]:
            if item.get("thisWeek"):
                item["thisWeek"] = False
                cleared += 1
        if cleared:
            save_store(data)
            log_change(actor, "cleared the this-week flag on", "items", "", f"{cleared} items")
        return {"cleared": cleared}


def import_links(body: dict, actor: str) -> dict:
    rows = body.get("rows")
    if not isinstance(rows, list) or len(rows) > 500:
        raise ValueError("rows must be a list of up to 500 entries")
    with LOCK:
        data = load_store()
        by_title = {i["title"].strip().lower(): i for i in data["items"]}
        matched, unmatched = 0, []
        for row in rows:
            title = str(row.get("title", "")).strip() if isinstance(row, dict) else ""
            url = str(row.get("url", "")).strip() if isinstance(row, dict) else ""
            item = by_title.get(title.lower())
            if item and re.match(r"https?://", url):
                item["link"] = url[:2000]
                matched += 1
            else:
                unmatched.append(title[:100])
        if matched:
            save_store(data)
            log_change(actor, "imported links", "items", "", f"{matched} links")
        return {"matched": matched, "unmatched": unmatched[:50]}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload, extra: dict | None = None) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8", extra)

    def _redirect(self, location: str) -> None:
        self._send(302, b"", "text/plain", {"Location": location})

    def _load_session(self) -> None:
        """Work out who is signed in (if anyone) once per request."""
        self.users = load_users()
        self.accounts = bool(self.users)
        # Accounts always work; they only become mandatory when REQUIRE_LOGIN=1.
        self.auth_on = self.accounts and os.environ.get("REQUIRE_LOGIN") == "1"
        self.user, self.account, self.role = None, None, -1
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except Exception:
            return
        morsel = jar.get(COOKIE)
        name = token_user(morsel.value) if morsel else None
        if name and name in self.users:
            self.user, self.account = name, self.users[name]
            self.role = ROLES.get(self.account.get("role"), 0)

    def _cookie(self, value: str, max_age: int) -> str:
        secure = os.environ.get("COOKIE_SECURE") == "1" or self.headers.get("X-Forwarded-Proto") == "https"
        return f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}" + ("; Secure" if secure else "")

    def _login(self) -> None:
        ip, now = self.client_address[0], time.time()
        recent = [t for t in FAILED_LOGINS.get(ip, []) if now - t < 60]
        if len(recent) >= 8:
            self._json(429, {"ok": False, "error": "Too many attempts. Wait a minute and try again."})
            return
        body = self._body()
        name = str(body.get("username", "")).strip().lower()[:40]
        account = self.users.get(name)
        good = check_password(str(body.get("password", ""))[:200], account["hash"] if account else DUMMY_HASH) and account is not None
        if not good:
            FAILED_LOGINS[ip] = recent + [now]
            self._json(401, {"ok": False, "error": "Incorrect username or password"})
            return
        FAILED_LOGINS.pop(ip, None)
        self._json(200, {"ok": True}, {"Set-Cookie": self._cookie(make_token(name), SESSION_HOURS * 3600)})

    def _can_jordan(self) -> bool:
        if self.user:
            return self.role >= ROLES["owner"]
        return False if self.auth_on else self._can_write()

    def _can_write(self) -> bool:
        if self.user:
            return self.role >= ROLES["editor"]
        if self.auth_on:
            return False
        key = os.environ.get("EDIT_KEY", "")
        if key:
            ip, now = self.client_address[0], time.time()
            recent = [t for t in FAILED_KEYS.get(ip, []) if now - t < 60]
            if len(recent) >= 10:
                return False
            supplied = self.headers.get("X-Edit-Key", "")
            ok = hmac.compare_digest(supplied, key)
            if supplied and not ok:
                recent.append(now)
            FAILED_KEYS[ip] = recent
            return ok
        # No key configured: only direct local access may edit (never via a proxy).
        return self.client_address[0] in ("127.0.0.1", "::1") and "X-Forwarded-For" not in self.headers

    def _actor(self) -> str:
        if self.account:
            return self.account.get("name") or self.user
        name = re.sub(r"[\x00-\x1f]", "", unquote(self.headers.get("X-Editor", ""))).strip()[:60]
        return name or "Unknown"

    def _body(self, limit: int = MAX_BODY) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > limit:
            raise ValueError("Invalid request body")
        try:
            parsed = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Invalid JSON")
        if not isinstance(parsed, dict):
            raise ValueError("Invalid JSON")
        return parsed

    def _route(self, method: str) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        parts = [p for p in parsed.path.split("/") if p]
        try:
            self._load_session()
            origin = self.headers.get("Origin")
            if method != "GET" and origin and urlparse(origin).netloc not in {self.headers.get("Host", ""), self.headers.get("X-Forwarded-Host", "")}:
                self._json(403, {"ok": False, "error": "Cross-site request blocked"})
                return
            if method == "POST" and parsed.path == "/api/login":
                self._login()
                return
            if method == "POST" and parsed.path == "/api/logout":
                self._json(200, {"ok": True}, {"Set-Cookie": self._cookie("", 0)})
                return
            if self.auth_on and not self.user and parsed.path != "/api/auth":
                if parsed.path.startswith("/api/"):
                    self._json(401, {"ok": False, "error": "Sign in required"})
                    return
                if parsed.path in STATIC_FILES:
                    self._redirect("/login")
                    return
            if method == "GET":
                if parsed.path == "/login" and (self.user or not self.accounts):
                    self._redirect("/")
                    return
                if parsed.path == "/api/data":
                    with LOCK:
                        data = load_store()
                    view_only = self.user is not None and self.role < ROLES["editor"]
                    self._json(200, strip_internal(data) if query.get("exec") or view_only else data)
                    return
                if parsed.path == "/api/auth":
                    self._json(200, {"authRequired": self.auth_on, "accounts": self.accounts, "user": (self.account.get("name") or self.user) if self.user else None,
                                     "role": self.account.get("role") if self.account else None, "canEdit": self._can_write(), "canJordan": self._can_jordan(),
                                     "keyRequired": bool(os.environ.get("EDIT_KEY")) and not self.user and not self.auth_on})
                    return
                if parsed.path == "/api/history":
                    with LOCK:
                        self._json(200, load_history())
                    return
                if parsed.path == "/api/changelog":
                    if not self._can_write():
                        self._json(403, {"ok": False, "error": "Editors only"})
                        return
                    try:
                        limit = max(1, min(500, int((query.get("limit") or ["100"])[0])))
                    except ValueError:
                        limit = 100
                    with LOCK:
                        self._json(200, read_changelog(limit))
                    return
                if parsed.path == "/api/jordan":
                    if not self._can_jordan():
                        self._json(403, {"ok": False, "error": "Requires the edit key"})
                        return
                    with LOCK:
                        self._json(200, load_jordan())
                    return
                filename = STATIC_FILES.get(parsed.path) or PUBLIC_FILES.get(parsed.path)
                if filename:
                    self._send(200, (WEB_DIR / filename).read_bytes(), CONTENT_TYPES[Path(filename).suffix])
                    return
                self.send_error(404, "Not found")
                return

            if not parts or parts[0] != "api":
                self.send_error(404, "Not found")
                return
            if not self._can_write():
                self._json(403, {"ok": False, "error": "Editing requires the edit key"})
                return
            actor = self._actor()

            if method == "POST" and len(parts) == 2 and parts[1] in FIELDS:
                self._json(200, upsert(parts[1], self._body(), actor))
            elif method == "POST" and len(parts) == 2 and parts[1] == "clear-week":
                self._json(200, clear_week(actor))
            elif method == "POST" and len(parts) == 2 and parts[1] == "import-links":
                self._json(200, import_links(self._body(), actor))
            elif method == "POST" and len(parts) == 4 and parts[1] == "items" and parts[3] == "updates":
                self._json(200, add_update(parts[2], self._body(), actor))
            elif method == "DELETE" and len(parts) == 2 and parts[1] in FIELDS:
                delete(parts[1], (query.get("id") or [""])[0], actor)
                self._json(200, {"ok": True})
            elif method == "PUT" and len(parts) == 3 and parts[1] == "pillars":
                self._json(200, update_pillar(parts[2], self._body(), actor))
            elif method == "PUT" and len(parts) == 2 and parts[1] == "jordan":
                if not self._can_jordan():
                    self._json(403, {"ok": False, "error": "Requires the edit key"})
                    return
                self._json(200, save_jordan(self._body(MAX_JORDAN_BODY)))
            else:
                self.send_error(404, "Not found")
        except ValueError as exc:
            self._json(400, {"ok": False, "error": str(exc)})
        except KeyError:
            self._json(404, {"ok": False, "error": "Not found"})
        except Exception:
            self._json(500, {"ok": False, "error": "Unexpected server error"})

    def do_GET(self) -> None:
        self._route("GET")

    def do_POST(self) -> None:
        self._route("POST")

    def do_PUT(self) -> None:
        self._route("PUT")

    def do_DELETE(self) -> None:
        self._route("DELETE")


def run() -> None:
    load_dotenv(ROOT / ".env")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK:
        take_snapshot(load_store())
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8090"))
    if os.environ.get("REQUIRE_LOGIN") == "1" and load_users():
        mode = "sign-in required"
    elif load_users():
        mode = "sign-in available, not required"
    else:
        mode = "edit key required" if os.environ.get("EDIT_KEY") else "local-only editing"
    print(f"Team Showcase running at http://{host}:{port} ({mode})")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        manage_users(sys.argv[1:])
    else:
        run()
