#!/usr/bin/env python3
from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import threading
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "apps" / "web"
SCHEMA_PATH = ROOT / "apps" / "api" / "sql" / "schema.sql"
DEFAULT_REPORTS_DIR = ROOT / "apps" / "api" / "reports"
PROTECTED_PAGES = {"/dashboard.html", "/shop.html", "/owner.html", "/bill-print.html"}
SESSION_COOKIE_DEFAULT = "sr_session"


def load_dotenv(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key or key in os.environ:
            continue
        if (
            len(value) >= 2
            and ((value[0] == value[-1] == '"') or (value[0] == value[-1] == "'"))
        ):
            value = value[1:-1]
        os.environ[key] = value


def env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None else value


def env_optional(name: str) -> str | None:
    return os.environ.get(name)


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, ""))
    except ValueError:
        return default


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def today_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def as_number(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return n if n == n and n not in (float("inf"), float("-inf")) else 0.0


def money(value: Any) -> float:
    return round(as_number(value), 2)


def random_token(byte_count: int = 32) -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(byte_count)).decode("ascii").rstrip("=")


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


PBKDF2_PREFIX = "pbkdf2_sha256"
PBKDF2_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS
    )
    return f"{PBKDF2_PREFIX}${PBKDF2_ITERATIONS}${b64url(salt)}${b64url(digest)}"


def verify_password(password: str, stored_hash: str) -> bool:
    parts = str(stored_hash or "").split("$")
    if len(parts) != 4 or parts[0] != PBKDF2_PREFIX:
        return False
    try:
        iterations = int(parts[1])
        salt = b64url_decode(parts[2])
        expected = b64url_decode(parts[3])
    except (ValueError, TypeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def is_python_password_hash(value: str | None) -> bool:
    return str(value or "").startswith(f"{PBKDF2_PREFIX}$")


PRODUCT_CATEGORIES = {
    "WHISKEY",
    "BRANDY",
    "RUM",
    "BEER",
    "GIN",
    "VODKA",
    "WINE",
    "CARBONATED_WINE",
    "OTHERS",
}

GENERAL_SIZES = [
    "1 Litre",
    "2 Litre",
    "1000ML",
    "750ML",
    "700ML",
    "650ML",
    "500ML",
    "375ML",
    "330ML",
    "275ML",
    "200ML",
    "180ML",
    "150ML",
    "90ML",
    "60ML",
    "50ML",
]
BEER_SIZES = ["650ML", "500 TIN", "330 TIN", "330 PINT", "275ML"]
GENERAL_SIZE_SET = set(GENERAL_SIZES)
BEER_SIZE_SET = set(BEER_SIZES)


def normalize_category(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        return "OTHERS"
    key = re.sub(r"[\s-]+", "_", text.upper())
    if key in PRODUCT_CATEGORIES:
        return key
    if key == "WHISKY":
        return "WHISKEY"
    if key == "OTHER":
        return "OTHERS"
    return "OTHERS"


def size_key(value: str) -> str:
    return re.sub(r"(\d)\s+ML\b", r"\1ML", re.sub(r"\s+", " ", value.upper().strip()))


SIZE_CANON = {size_key(size): size for size in [*GENERAL_SIZES, *BEER_SIZES]}


def canonical_size(raw: Any) -> str | None:
    text = str(raw or "").strip()
    if not text:
        return None
    return SIZE_CANON.get(size_key(text))


def is_valid_size_for_category(category: str, size: str | None) -> bool:
    if not size:
        return False
    return size in (BEER_SIZE_SET if category == "BEER" else GENERAL_SIZE_SET)


def default_size_for_category(category: str) -> str:
    return "650ML" if category == "BEER" else "750ML"


def normalize_size(category: str, raw: Any) -> str:
    canon = canonical_size(raw)
    if canon and is_valid_size_for_category(category, canon):
        return canon
    return default_size_for_category(category)


def normalize_bottles_per_case(category: str, size: str | None, raw: Any) -> int:
    if size == "90ML":
        return 96
    if category == "BEER" and size == "650ML":
        return 12
    try:
        parsed = int(str(raw or "").strip())
    except ValueError:
        return 12
    return parsed if parsed > 0 else 12


def coerce_imported_size(category: str, raw_size: Any) -> str:
    text = str(raw_size or "").strip()
    if not text:
        return text
    upper = text.upper()
    if category == "BEER" and upper == "PINT":
        return "330 PINT"
    if upper.isdigit():
        n = int(upper)
        if category == "BEER":
            if n == 500:
                return "500 TIN"
            if n == 330:
                return "330 TIN"
            if n == 650:
                return "650ML"
            if n == 275:
                return "275ML"
        return f"{n}ML"
    return text


def category_label(raw: Any) -> str:
    key = normalize_category(raw)
    labels = {
        "WHISKEY": "Whiskey",
        "BRANDY": "Brandy",
        "RUM": "Rum",
        "VODKA": "Vodka",
        "GIN": "Gin",
        "BEER": "Beer",
        "WINE": "Wine",
        "CARBONATED_WINE": "Carbonated Wine",
        "OTHERS": "Others",
    }
    return labels.get(key, key.title())


REPORT_CATEGORY_ORDER = ["WHISKEY", "BRANDY", "RUM", "VODKA", "GIN", "OTHERS", "BEER"]


def report_category_section(raw: Any) -> str:
    key = normalize_category(raw)
    return key if key in {"WHISKEY", "BRANDY", "RUM", "VODKA", "GIN", "BEER"} else "OTHERS"


class ApiError(Exception):
    def __init__(self, status: int, message: str, details: Any = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details


@dataclass
class ResponseData:
    status: int
    body: bytes
    headers: list[tuple[str, str]]


def json_response(data: Any, status: int = 200, extra_headers: list[tuple[str, str]] | None = None) -> ResponseData:
    body = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = [("Content-Type", "application/json; charset=utf-8")]
    if extra_headers:
        headers.extend(extra_headers)
    return ResponseData(status, body, headers)


def error_response(status: int, message: str, details: Any = None) -> ResponseData:
    return json_response({"ok": False, "error": {"message": message, "details": details}}, status)


def redirect_response(to: str) -> ResponseData:
    return ResponseData(302, b"", [("Location", to)])


def not_found() -> ResponseData:
    return error_response(404, "Not found")


def parse_cookies(raw_cookie: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    if not raw_cookie:
        return out
    for part in raw_cookie.split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        out[key.strip()] = urllib.parse.unquote(value.strip())
    return out


def make_cookie_header(name: str, value: str, max_age: int | None = None) -> str:
    parts = [f"{name}={urllib.parse.quote(value)}", "Path=/", "HttpOnly", "SameSite=Lax"]
    if max_age is not None:
        parts.append(f"Max-Age={max_age}")
    if env("PUBLIC_BASE_URL", "http://localhost:3000").startswith("https://"):
        parts.append("Secure")
    return "; ".join(parts)


def clear_cookie_header(name: str) -> str:
    return f"{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"


def safe_resolve(root: Path, url_path: str) -> Path | None:
    if "\0" in url_path:
        return None
    rel = url_path.lstrip("/")
    candidate = (root / rel).resolve()
    root_resolved = root.resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        return None
    return candidate


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return None if row is None else {key: row[key] for key in row.keys()}


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [row_to_dict(row) or {} for row in rows]


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.column_cache: dict[tuple[str, str], bool] = {}
        self.exec("PRAGMA journal_mode = WAL")
        self.exec("PRAGMA foreign_keys = ON")

    def exec(self, sql: str) -> None:
        with self.lock:
            self.conn.execute(sql)

    def executescript(self, sql: str) -> None:
        with self.lock:
            self.conn.executescript(sql)

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self.lock:
            return self.conn.execute(sql, params)

    def one(self, sql: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def all(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def has_column(self, table: str, column: str) -> bool:
        key = (table, column)
        if key in self.column_cache:
            return self.column_cache[key]
        if not re.fullmatch(r"[A-Za-z0-9_]+", table) or not re.fullmatch(r"[A-Za-z0-9_]+", column):
            return False
        rows = self.all(f"PRAGMA table_info({table})")
        found = any(row["name"] == column for row in rows)
        self.column_cache[key] = found
        return found

    def ensure_column(self, table: str, column: str, column_type: str) -> None:
        if self.has_column(table, column):
            return
        with self.lock:
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")
            self.column_cache[(table, column)] = True


def migrate(db: Database) -> None:
    db.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    for table, column, column_type in [
        ("shops", "address", "TEXT"),
        ("users", "shop_id", "INTEGER"),
        ("products", "category", "TEXT"),
        ("products", "size", "TEXT"),
        ("products", "bottles_per_case", "INTEGER"),
        ("stock_transactions", "invoice_no", "TEXT"),
        ("stock_transactions", "doc_date", "TEXT"),
        ("stock_transactions", "permit_no", "TEXT"),
        ("stock_transactions", "vehicle_no", "TEXT"),
        ("stock_transactions", "incoming_name", "TEXT"),
        ("stock_transactions", "cases", "INTEGER"),
        ("stock_transactions", "bottles", "INTEGER"),
        ("stock_transactions", "source", "TEXT"),
    ]:
        db.ensure_column(table, column, column_type)


def load_stock_master_products() -> list[dict[str, str]]:
    stock_path = ROOT / "stock_master.csv"
    if not stock_path.exists():
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    with stock_path.open("r", encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file)
        for row in reader:
            name = str(row.get("product_name") or "").strip()
            if not name:
                continue
            category = normalize_category(row.get("category"))
            raw_size = row.get("size") or row.get("size_ml") or ""
            size = normalize_size(category, coerce_imported_size(category, raw_size))
            key = f"{category}|{name}|{size}"
            if key in seen:
                continue
            seen.add(key)
            out.append({"name": name, "category": category, "size": size})
    return out


def seed_if_needed(db: Database) -> None:
    admin_username = env("ADMIN_USERNAME", "owner")
    admin_password_env = env_optional("ADMIN_PASSWORD")
    admin_password = admin_password_env or "owner123"

    shops = [
        ("Ravi Liquor Shop", "SR complex no: 03,S.R(Sirige Rudramuniyappa) Ring Road,Rahim Nagara,challakere-577522"),
        ("Aishwarya Bar", "SH 48,near Government degree College ground, chitradurga Road, Challakere-577522"),
        ("S R Residency", "OPP Busstand, challakere,Karnataka 577522"),
    ]

    with db.lock:
        for name, address in shops:
            db.conn.execute("INSERT OR IGNORE INTO shops (name, address) VALUES (?, ?)", (name, address))
            db.conn.execute(
                "UPDATE shops SET address = ? WHERE name = ? AND (address IS NULL OR TRIM(address) = '')",
                (address, name),
            )

        for row in db.conn.execute("SELECT id FROM shops").fetchall():
            db.conn.execute(
                "INSERT OR IGNORE INTO bill_counters (shop_id, next_bill_no) VALUES (?, 1)",
                (row["id"],),
            )

        shop_rows = db.conn.execute("SELECT id, name FROM shops").fetchall()
        shop_id_by_name = {row["name"]: row["id"] for row in shop_rows}

        ensure_user(
            db,
            admin_username,
            admin_password,
            "OWNER",
            None,
            rotate_password=admin_password_env is not None,
        )

        shop_users = [
            {
                "shop_name": "Ravi Liquor Shop",
                "username": env("SHOP1_USERNAME", "ravi"),
                "password": env_optional("SHOP1_PASSWORD") or "ravi123",
                "rotate": env_optional("SHOP1_PASSWORD") is not None,
            },
            {
                "shop_name": "Aishwarya Bar",
                "username": env("SHOP2_USERNAME", "aishwarya"),
                "password": env_optional("SHOP2_PASSWORD") or "aishwarya123",
                "rotate": env_optional("SHOP2_PASSWORD") is not None,
            },
            {
                "shop_name": "S R Residency",
                "username": env("SHOP3_USERNAME", "srresidency"),
                "password": env_optional("SHOP3_PASSWORD") or "srresidency123",
                "rotate": env_optional("SHOP3_PASSWORD") is not None,
            },
        ]
        for shop_user in shop_users:
            shop_id = shop_id_by_name.get(shop_user["shop_name"])
            if shop_id is None:
                continue
            ensure_user(
                db,
                str(shop_user["username"]),
                str(shop_user["password"]),
                "STAFF",
                int(shop_id),
                rotate_password=bool(shop_user["rotate"]),
            )

        default_products = [
            {"name": "MH BRANDY", "size": "1000ML", "category": "BRANDY"},
            {"name": "MH BRANDY", "size": "750ML", "category": "BRANDY"},
            {"name": "MH BRANDY", "size": "375ML", "category": "BRANDY"},
            {"name": "MH BRANDY", "size": "180ML", "category": "BRANDY"},
            {"name": "MH BRANDY", "size": "90ML", "category": "BRANDY"},
            {"name": "MORPHEUS BLUE", "size": "180ML", "category": "BRANDY"},
            {"name": "MORPHEUS BLUE", "size": "60ML", "category": "BRANDY"},
            {"name": "MC BRANDY", "size": "180ML", "category": "BRANDY"},
            {"name": "MC BRANDY", "size": "90ML", "category": "BRANDY"},
            {"name": "BAGPIPER WHISKY", "size": "750ML", "category": "WHISKEY"},
            {"name": "BAGPIPER WHISKY", "size": "375ML", "category": "WHISKEY"},
            {"name": "BAGPIPER WHISKY", "size": "180ML", "category": "WHISKEY"},
            {"name": "BAGPIPER WHISKY", "size": "90ML", "category": "WHISKEY"},
        ]

        seed_products: list[dict[str, str]] = []
        seen: set[str] = set()
        for raw in [*default_products, *load_stock_master_products()]:
            name = str(raw.get("name") or "").strip()
            if not name:
                continue
            category = normalize_category(raw.get("category"))
            size = normalize_size(category, raw.get("size"))
            key = f"{category}|{name}|{size}"
            if key in seen:
                continue
            seen.add(key)
            seed_products.append({"name": name, "category": category, "size": size})

        for shop_name in ["Ravi Liquor Shop", "Aishwarya Bar"]:
            shop_id = shop_id_by_name.get(shop_name)
            if shop_id is None:
                continue
            for product in seed_products:
                existing = db.conn.execute(
                    """
                    SELECT id FROM products
                    WHERE shop_id = ? AND name = ? AND category = ? AND COALESCE(size,'') = ?
                    LIMIT 1
                    """,
                    (shop_id, product["name"], product["category"], product["size"]),
                ).fetchone()
                if existing:
                    continue
                db.conn.execute(
                    """
                    INSERT INTO products
                      (shop_id, name, category, size, bottles_per_case, current_qty, sale_price, min_qty, updated_at)
                    VALUES (?, ?, ?, ?, ?, 0, 0, 0, datetime('now','localtime'))
                    """,
                    (
                        shop_id,
                        product["name"],
                        product["category"],
                        product["size"],
                        normalize_bottles_per_case(product["category"], product["size"], 12),
                    ),
                )


def ensure_user(
    db: Database,
    username: str,
    password: str,
    role: str,
    shop_id: int | None,
    rotate_password: bool = False,
) -> None:
    row = db.conn.execute(
        "SELECT id, password_hash FROM users WHERE username = ?", (username,)
    ).fetchone()
    if row is None:
        db.conn.execute(
            "INSERT INTO users (username, password_hash, role, shop_id) VALUES (?, ?, ?, ?)",
            (username, hash_password(password), role, shop_id),
        )
        print(f"[seed] Created {role} user '{username}'.")
        return
    must_convert = not is_python_password_hash(row["password_hash"])
    if rotate_password or must_convert:
        db.conn.execute(
            "UPDATE users SET password_hash = ?, role = ?, shop_id = ? WHERE id = ?",
            (hash_password(password), role, shop_id, row["id"]),
        )
        print(f"[seed] Updated password format for '{username}'.")
    else:
        db.conn.execute(
            "UPDATE users SET role = ?, shop_id = ? WHERE id = ?", (role, shop_id, row["id"])
        )


def ascii_safe(value: str) -> str:
    return "".join(ch if 32 <= ord(ch) <= 126 else "?" for ch in value)


def esc_pdf_text(value: str) -> str:
    return ascii_safe(value).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def pdf_from_lines(title: str, lines: list[dict[str, Any]]) -> bytes:
    page_width = 612
    page_height = 792
    margin_x = 32
    start_y = page_height - 58
    line_gap = 13

    pages: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    y = start_y

    def push(line: dict[str, Any]) -> None:
        nonlocal current, y
        if y < 52:
            pages.append(current)
            current = []
            y = start_y
        current.append(line)
        y -= line_gap

    push({"text": title, "bold": True, "size": 16, "align": "center"})
    push({"text": "", "size": 10})
    for line in lines:
        push(line)
    if current or not pages:
        pages.append(current)

    objects: list[str] = []

    def add_obj(body: str) -> int:
        obj_id = len(objects) + 1
        objects.append(f"{obj_id} 0 obj\n{body}\nendobj\n")
        return obj_id

    font_regular = add_obj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")
    font_bold = add_obj("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>")
    page_ids: list[int] = []

    def text_width(text: str, size: float) -> float:
        return len(ascii_safe(text)) * size * 0.6

    for page_lines in pages:
        parts = ["BT"]
        for idx, line in enumerate(page_lines):
            size = float(line.get("size") or 10)
            font = font_bold if line.get("bold") else font_regular
            raw_text = str(line.get("text") or "")
            text = esc_pdf_text(raw_text)
            line_y = start_y - idx * line_gap
            align = line.get("align") or "left"
            x = margin_x
            if align == "center":
                x = max(margin_x, (page_width - text_width(raw_text, size)) / 2)
            elif align == "right":
                x = max(margin_x, page_width - margin_x - text_width(raw_text, size))
            parts.append(f"/F{font} {size:.2f} Tf")
            parts.append(f"1 0 0 1 {x:.2f} {line_y:.2f} Tm")
            parts.append(f"({text}) Tj")
        parts.append("ET")
        stream = "\n".join(parts)
        content_id = add_obj(
            f"<< /Length {len(stream.encode('ascii'))} >>\nstream\n{stream}\nendstream"
        )
        page_id = add_obj(
            f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 {page_width} {page_height}] "
            f"/Resources << /Font << /F{font_regular} {font_regular} 0 R /F{font_bold} {font_bold} 0 R >> >> "
            f"/Contents {content_id} 0 R >>"
        )
        page_ids.append(page_id)

    pages_id = add_obj(
        f"<< /Type /Pages /Kids [{' '.join(f'{page_id} 0 R' for page_id in page_ids)}] /Count {len(page_ids)} >>"
    )
    objects = [obj.replace("/Parent 0 0 R", f"/Parent {pages_id} 0 R") for obj in objects]
    catalog_id = add_obj(f"<< /Type /Catalog /Pages {pages_id} 0 R >>")

    pdf = "%PDF-1.4\n"
    offsets = [0]
    for obj in objects:
        offsets.append(len(pdf.encode("ascii")))
        pdf += obj
    xref_start = len(pdf.encode("ascii"))
    pdf += f"xref\n0 {len(objects) + 1}\n"
    pdf += "0000000000 65535 f \n"
    for offset in offsets[1:]:
        pdf += f"{offset:010d} 00000 n \n"
    pdf += f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\nstartxref\n{xref_start}\n%%EOF"
    return pdf.encode("ascii")


def left_cell(value: Any, width: int) -> str:
    text = str(value or "")
    return text[:width].ljust(width)


def right_cell(value: Any, width: int) -> str:
    text = str(value or "")
    return text[:width].rjust(width)


def wrap_cell(value: Any, width: int) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return [""]
    words = re.split(r"\s+", text)
    out: list[str] = []
    current = ""
    for raw_word in words:
        word = raw_word
        if len(word) > width:
            if current:
                out.append(current)
                current = ""
            while len(word) > width:
                out.append(word[:width])
                word = word[width:]
        if not current:
            current = word
        elif len(current) + 1 + len(word) <= width:
            current += f" {word}"
        else:
            out.append(current)
            current = word
    if current:
        out.append(current)
    return out or [""]


class AppState:
    def __init__(self, db: Database):
        self.db = db

    def get_session_token(self, handler: BaseHTTPRequestHandler) -> str | None:
        cookie_name = env("SESSION_COOKIE_NAME", SESSION_COOKIE_DEFAULT)
        return parse_cookies(handler.headers.get("Cookie")).get(cookie_name)

    def create_session(self, user_id: int) -> tuple[str, str]:
        token = random_token(32)
        token_hash = sha256_hex(token)
        ttl_days = env_int("SESSION_TTL_DAYS", 14)
        expires_at = (datetime.utcnow() + timedelta(days=ttl_days)).strftime("%Y-%m-%d %H:%M:%S")
        with self.db.lock:
            self.db.conn.execute(
                """
                INSERT INTO sessions (user_id, token_hash, expires_at, last_used_at)
                VALUES (?, ?, ?, datetime('now'))
                """,
                (user_id, token_hash, expires_at),
            )
        return token, expires_at

    def delete_session(self, token: str) -> None:
        with self.db.lock:
            self.db.conn.execute("DELETE FROM sessions WHERE token_hash = ?", (sha256_hex(token),))

    def get_user(self, handler: BaseHTTPRequestHandler) -> dict[str, Any] | None:
        token = self.get_session_token(handler)
        if not token:
            return None
        token_hash = sha256_hex(token)
        with self.db.lock:
            row = self.db.conn.execute(
                """
                SELECT u.id AS id, u.username AS username, u.role AS role, u.shop_id AS shopId
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND datetime(s.expires_at) > datetime('now')
                """,
                (token_hash,),
            ).fetchone()
            if row is None:
                return None
            self.db.conn.execute(
                "UPDATE sessions SET last_used_at = datetime('now') WHERE token_hash = ?",
                (token_hash,),
            )
            return row_to_dict(row)

    def require_auth(self, handler: BaseHTTPRequestHandler) -> dict[str, Any]:
        user = self.get_user(handler)
        if user is None:
            raise ApiError(401, "Unauthorized")
        return user

    @staticmethod
    def require_shop_access(user: dict[str, Any], shop_id: int) -> None:
        if user.get("role") == "OWNER":
            return
        if int(user.get("shopId") or 0) != shop_id:
            raise ApiError(403, "Forbidden")

    def login(self, username: str, password: str) -> dict[str, Any] | None:
        with self.db.lock:
            row = self.db.conn.execute(
                "SELECT id, username, password_hash, role, shop_id FROM users WHERE username = ?",
                (username,),
            ).fetchone()
            if row is None or not verify_password(password, row["password_hash"]):
                return None
            return {
                "id": row["id"],
                "username": row["username"],
                "role": row["role"],
                "shopId": row["shop_id"],
            }


def parse_json_body(handler: BaseHTTPRequestHandler) -> Any:
    length = int(handler.headers.get("Content-Length") or "0")
    if length <= 0:
        return None
    raw = handler.rfile.read(length)
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return None


def parse_id(value: str | None, label: str) -> int:
    try:
        parsed = int(str(value or ""))
    except ValueError:
        raise ApiError(400, f"Invalid {label}")
    return parsed


@dataclass
class Route:
    method: str
    pattern: str
    handler: Callable[[AppState, BaseHTTPRequestHandler, urllib.parse.ParseResult, dict[str, str]], ResponseData]

    def match(self, method: str, pathname: str) -> dict[str, str] | None:
        if method.upper() != self.method:
            return None
        if self.pattern == pathname:
            return {}
        pattern_parts = [part for part in self.pattern.split("/") if part]
        path_parts = [part for part in pathname.split("/") if part]
        if len(pattern_parts) != len(path_parts):
            return None
        params: dict[str, str] = {}
        for pattern_part, path_part in zip(pattern_parts, path_parts):
            if pattern_part.startswith(":"):
                params[pattern_part[1:]] = urllib.parse.unquote(path_part)
            elif pattern_part != path_part:
                return None
        return params


ROUTES: list[Route] = []


def route(method: str, pattern: str):
    def decorator(func):
        ROUTES.append(Route(method.upper(), pattern, func))
        return func

    return decorator


@route("GET", "/api/health")
def api_health(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    return json_response({"ok": True})


@route("POST", "/api/auth/login")
def api_login(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    body = parse_json_body(handler) or {}
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")
    if not username or not password:
        raise ApiError(400, "Missing username/password")
    user = state.login(username, password)
    if user is None:
        raise ApiError(401, "Invalid credentials")
    token, _expires_at = state.create_session(int(user["id"]))
    cookie_name = env("SESSION_COOKIE_NAME", SESSION_COOKIE_DEFAULT)
    cookie = make_cookie_header(cookie_name, token, env_int("SESSION_TTL_DAYS", 14) * 86400)
    return json_response({"ok": True, "user": user}, extra_headers=[("Set-Cookie", cookie)])


@route("POST", "/api/auth/logout")
def api_logout(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    token = state.get_session_token(handler)
    if token:
        state.delete_session(token)
    cookie_name = env("SESSION_COOKIE_NAME", SESSION_COOKIE_DEFAULT)
    return json_response({"ok": True}, extra_headers=[("Set-Cookie", clear_cookie_header(cookie_name))])


@route("GET", "/api/auth/me")
def api_me(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    return json_response({"ok": True, "user": user, "ai": {"enabled": True, "engine": "local-ollama"}})


@route("POST", "/api/ai/chat")
def api_ai_chat(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    state.require_auth(handler)
    raise ApiError(501, "Local AI moved", "Use the self-hosted Node/Ollama service.")


@route("GET", "/api/shops")
def api_shops(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    with state.db.lock:
        if user["role"] == "OWNER":
            rows = state.db.conn.execute("SELECT id, name, address FROM shops ORDER BY id").fetchall()
        else:
            rows = state.db.conn.execute(
                "SELECT id, name, address FROM shops WHERE id = ? ORDER BY id", (user["shopId"],)
            ).fetchall()
    return json_response({"ok": True, "shops": rows_to_dicts(rows)})


def compute_daily_summary(db: Database, shop_id: int, date: str) -> dict[str, Any]:
    shop = db.conn.execute("SELECT id, name FROM shops WHERE id = ?", (shop_id,)).fetchone()
    if shop is None:
        raise ApiError(404, "Shop not found")
    sales = db.conn.execute(
        "SELECT COALESCE(SUM(total), 0) AS sales_total FROM bills WHERE shop_id = ? AND date(created_at) = ?",
        (shop_id, date),
    ).fetchone()
    return {
        "shopId": shop["id"],
        "shopName": shop["name"],
        "salesTotal": money(sales["sales_total"] if sales else 0),
    }


def combine_summaries(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    return {"salesTotal": money(sum(as_number(s.get("salesTotal")) for s in summaries))}


@route("GET", "/api/dashboard/summary")
def api_dashboard_summary(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    query = urllib.parse.parse_qs(url.query)
    report_date = (query.get("date") or [today_iso()])[0]
    with state.db.lock:
        if user["role"] == "OWNER":
            shops = state.db.conn.execute("SELECT id, name FROM shops ORDER BY id").fetchall()
        else:
            shops = state.db.conn.execute(
                "SELECT id, name FROM shops WHERE id = ? ORDER BY id", (user["shopId"],)
            ).fetchall()
        per_shop = [compute_daily_summary(state.db, int(shop["id"]), report_date) for shop in shops]
    return json_response({"ok": True, "date": report_date, "combined": combine_summaries(per_shop), "shops": per_shop})


@route("GET", "/api/shops/:shopId/summary")
def api_shop_summary(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    query = urllib.parse.parse_qs(url.query)
    report_date = (query.get("date") or [today_iso()])[0]
    with state.db.lock:
        summary = compute_daily_summary(state.db, shop_id, report_date)
    return json_response({"ok": True, "date": report_date, "summary": summary})


def product_where_from_query(shop_id: int, query: dict[str, list[str]]) -> tuple[list[str], list[Any], bool]:
    category_raw = (query.get("category") or [""])[0].strip()
    others_only = re.fullmatch(r"(1|true|yes)", (query.get("othersItemsOnly") or [""])[0].strip(), re.I) is not None
    non_stock_clause = "(size IS NULL AND current_qty = 0 AND min_qty = 0 AND barcode IS NULL)"
    where = ["shop_id = ?"]
    args: list[Any] = [shop_id]
    viewing_others = False
    if category_raw and category_raw.upper() != "ALL":
        key = re.sub(r"[\s-]+", "_", category_raw.upper())
        if key == "OTHERS_PLUS_GIN":
            where.append(non_stock_clause)
            viewing_others = True
        else:
            where.append("category = ?")
            args.append(normalize_category(key))
    if others_only and not viewing_others:
        where.append(non_stock_clause)
        viewing_others = True
    if not viewing_others:
        where.append(f"NOT {non_stock_clause}")
    size = canonical_size((query.get("size") or [""])[0])
    if size:
        where.append("size = ?")
        args.append(size)
    return where, args, viewing_others


@route("GET", "/api/shops/:shopId/products")
def api_products_get(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    query = urllib.parse.parse_qs(url.query)
    search = (query.get("search") or [""])[0].strip()
    starts_with = (query.get("startsWith") or [""])[0].strip()
    barcode = (query.get("barcode") or [""])[0].strip()
    include_total = re.fullmatch(r"(1|true|yes)", (query.get("includeTotal") or [""])[0].strip(), re.I) is not None
    try:
        limit = min(max(int((query.get("limit") or [""])[0]), 1), 5000)
    except ValueError:
        limit = 200
    try:
        offset = max(int((query.get("offset") or ["0"])[0]), 0)
    except ValueError:
        offset = 0

    with state.db.lock:
        if barcode:
            rows = state.db.conn.execute(
                "SELECT * FROM products WHERE shop_id = ? AND barcode = ? LIMIT 1",
                (shop_id, barcode),
            ).fetchall()
            total = len(rows)
        else:
            where, args, _viewing_others = product_where_from_query(shop_id, query)
            where_sql = " AND ".join(where)
            like_value = None
            if starts_with:
                like_value = f"{starts_with}%"
                limit = limit if "limit" in query else 80
            elif search:
                like_value = f"%{search}%"
                limit = limit if "limit" in query else 50
            if like_value is not None:
                rows = state.db.conn.execute(
                    f"""
                    SELECT * FROM products
                    WHERE {where_sql} AND name LIKE ?
                    ORDER BY name COLLATE NOCASE ASC, size ASC, id ASC
                    LIMIT ? OFFSET ?
                    """,
                    (*args, like_value, limit, offset),
                ).fetchall()
                total_row = state.db.conn.execute(
                    f"SELECT COUNT(1) AS c FROM products WHERE {where_sql} AND name LIKE ?",
                    (*args, like_value),
                ).fetchone()
            else:
                limit = limit if "limit" in query else 200
                rows = state.db.conn.execute(
                    f"""
                    SELECT * FROM products
                    WHERE {where_sql}
                    ORDER BY name COLLATE NOCASE ASC, size ASC, id ASC
                    LIMIT ? OFFSET ?
                    """,
                    (*args, limit, offset),
                ).fetchall()
                total_row = state.db.conn.execute(
                    f"SELECT COUNT(1) AS c FROM products WHERE {where_sql}", tuple(args)
                ).fetchone()
            total = int(total_row["c"] if total_row else 0)
    payload: dict[str, Any] = {"ok": True, "products": rows_to_dicts(rows)}
    if include_total:
        payload["total"] = total
    return json_response(payload)


@route("POST", "/api/shops/:shopId/products")
def api_products_post(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    body = parse_json_body(handler) or {}
    name = str(body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "Product name required")
    quick_add = str(body.get("quickAdd") or "").strip().upper()
    barcode = str(body.get("barcode") or "").strip() or None
    sku = str(body.get("sku") or "").strip() or None
    unit = str(body.get("unit") or "unit").strip() or "unit"
    category = normalize_category(body.get("category"))
    size: str | None = normalize_size(category, body.get("size"))
    bottles_per_case = normalize_bottles_per_case(category, size, body.get("bottlesPerCase"))
    sale_price = as_number(body.get("salePrice", body.get("mrp", 0)))
    cost_price = 0.0
    min_qty = as_number(body.get("minQty", 0))
    current_qty = as_number(body.get("currentQty", 0))
    if quick_add == "OTHERS_ITEMS":
        category = "OTHERS"
        size = None
        barcode = None
        sku = None
        unit = "unit"
        bottles_per_case = 0
        min_qty = 0
        current_qty = 0
        cost_price = 0
    with state.db.lock:
        cur = state.db.conn.execute(
            """
            INSERT INTO products
              (shop_id, sku, name, barcode, unit, category, size, bottles_per_case,
               sale_price, cost_price, min_qty, current_qty, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
            """,
            (
                shop_id,
                sku,
                name,
                barcode,
                unit,
                category,
                size,
                bottles_per_case,
                sale_price,
                cost_price,
                min_qty,
                current_qty,
            ),
        )
        product_id = int(cur.lastrowid)
        state.db.conn.execute(
            """
            INSERT INTO stock_transactions (shop_id, product_id, type, qty, note, user_id, created_at)
            VALUES (?, ?, 'ADJUST', ?, 'Initial stock', ?, datetime('now','localtime'))
            """,
            (shop_id, product_id, current_qty, user["id"]),
        )
    return json_response({"ok": True, "id": product_id, "category": category, "size": size})


@route("PUT", "/api/shops/:shopId/products/:productId")
def api_products_put(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    product_id = parse_id(params.get("productId"), "productId")
    state.require_shop_access(user, shop_id)
    body = parse_json_body(handler) or {}
    name = str(body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "Product name required")
    barcode = str(body.get("barcode") or "").strip() or None
    sku = str(body.get("sku") or "").strip() or None
    unit = str(body.get("unit") or "unit").strip() or "unit"
    sale_price = as_number(body.get("salePrice", 0))
    min_qty = as_number(body.get("minQty", 0))
    with state.db.lock:
        existing = state.db.conn.execute(
            "SELECT category, size, bottles_per_case FROM products WHERE id = ? AND shop_id = ?",
            (product_id, shop_id),
        ).fetchone()
        if existing is None:
            raise ApiError(404, "Product not found")
        existing_category = normalize_category(existing["category"])
        existing_size = canonical_size(existing["size"])
        category = normalize_category(body.get("category")) if "category" in body else existing_category
        if "size" in body:
            size = normalize_size(category, body.get("size"))
        elif "category" in body:
            size = existing_size if is_valid_size_for_category(category, existing_size) else default_size_for_category(category)
        else:
            size = existing_size if is_valid_size_for_category(existing_category, existing_size) else default_size_for_category(existing_category)
        bpc_input = body.get("bottlesPerCase", existing["bottles_per_case"] or 12)
        bottles_per_case = normalize_bottles_per_case(category, size, bpc_input)
        state.db.conn.execute(
            """
            UPDATE products
            SET sku = ?, name = ?, barcode = ?, unit = ?, category = ?, size = ?,
                bottles_per_case = ?, sale_price = ?, min_qty = ?,
                updated_at = datetime('now','localtime')
            WHERE id = ? AND shop_id = ?
            """,
            (
                sku,
                name,
                barcode,
                unit,
                category,
                size,
                bottles_per_case,
                sale_price,
                min_qty,
                product_id,
                shop_id,
            ),
        )
    return json_response({"ok": True})


@route("DELETE", "/api/shops/:shopId/products/:productId")
def api_products_delete(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    product_id = parse_id(params.get("productId"), "productId")
    state.require_shop_access(user, shop_id)
    with state.db.lock:
        existing = state.db.conn.execute(
            "SELECT id FROM products WHERE id = ? AND shop_id = ?", (product_id, shop_id)
        ).fetchone()
        if existing is None:
            raise ApiError(404, "Product not found")
        used = state.db.conn.execute(
            "SELECT 1 FROM bill_items WHERE product_id = ? LIMIT 1", (product_id,)
        ).fetchone()
        if used:
            raise ApiError(409, "Cannot delete product (used in bills)")
        state.db.conn.execute("DELETE FROM products WHERE id = ? AND shop_id = ?", (product_id, shop_id))
    return json_response({"ok": True})


@route("POST", "/api/shops/:shopId/stock/bill-of-invoice")
def api_bill_of_invoice(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    body = parse_json_body(handler) or {}
    doc_date = str(body.get("date") or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", doc_date):
        raise ApiError(400, "Invalid date")
    invoice_input = str(body.get("invoiceNo") or "").strip()
    permit_input = str(body.get("permitNo") or "").strip() or None
    vehicle_input = str(body.get("vehicleRegNo") or "").strip() or None
    product_id = parse_id(str(body.get("productId") or ""), "productId")
    cases = max(int(as_number(body.get("cases", 0))), 0)
    bottles = max(int(as_number(body.get("bottles", 0))), 0)
    if cases + bottles <= 0:
        raise ApiError(400, "Cases/Bottles required")
    with state.db.lock:
        existing_invoice = state.db.conn.execute(
            """
            SELECT invoice_no, permit_no, vehicle_no
            FROM stock_transactions
            WHERE shop_id = ? AND type = 'IN' AND note = 'KSBCL BILL OF INVOICE' AND doc_date = ?
            LIMIT 1
            """,
            (shop_id, doc_date),
        ).fetchone()
        if existing_invoice is None:
            if not invoice_input:
                raise ApiError(400, "Invoice No required")
            invoice_no = invoice_input
            permit_no = permit_input
            vehicle_no = vehicle_input
        else:
            existing_invoice_no = str(existing_invoice["invoice_no"] or "").strip()
            existing_permit_no = str(existing_invoice["permit_no"] or "").strip() or None
            existing_vehicle_no = str(existing_invoice["vehicle_no"] or "").strip() or None
            if (
                (invoice_input and invoice_input != existing_invoice_no)
                or (permit_input is not None and permit_input != existing_permit_no)
                or (vehicle_input is not None and vehicle_input != existing_vehicle_no)
            ):
                raise ApiError(409, "Invoice/Permit/Vehicle already set for this date")
            invoice_no = existing_invoice_no
            permit_no = existing_permit_no
            vehicle_no = existing_vehicle_no
        product = state.db.conn.execute(
            "SELECT category, size, bottles_per_case FROM products WHERE id = ? AND shop_id = ?",
            (product_id, shop_id),
        ).fetchone()
        if product is None:
            raise ApiError(404, "Product not found")
        category = normalize_category(product["category"])
        size = canonical_size(product["size"])
        bpc = normalize_bottles_per_case(category, size, product["bottles_per_case"])
        qty = cases * bpc + bottles
        if qty <= 0:
            raise ApiError(400, "Quantity must be > 0")
        state.db.conn.execute(
            "UPDATE products SET current_qty = current_qty + ?, updated_at = datetime('now','localtime') WHERE id = ? AND shop_id = ?",
            (qty, product_id, shop_id),
        )
        state.db.conn.execute(
            """
            INSERT INTO stock_transactions
              (shop_id, product_id, type, qty, note, doc_date, invoice_no, permit_no, vehicle_no,
               incoming_name, cases, bottles, source, user_id, created_at)
            VALUES
              (?, ?, 'IN', ?, 'KSBCL BILL OF INVOICE', ?, ?, ?, ?, 'KSBCL liquor depot',
               ?, ?, 'KSBCL', ?, datetime('now','localtime'))
            """,
            (
                shop_id,
                product_id,
                qty,
                doc_date,
                invoice_no,
                permit_no,
                vehicle_no,
                cases,
                bottles,
                user["id"],
            ),
        )
    return json_response({"ok": True})


@route("POST", "/api/shops/:shopId/stock/adjust")
def api_stock_adjust(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    body = parse_json_body(handler) or {}
    product_id = parse_id(str(body.get("productId") or ""), "productId")
    new_qty = as_number(body.get("newQty", 0))
    note = str(body.get("note") or "Stock adjust").strip() or "Stock adjust"
    with state.db.lock:
        row = state.db.conn.execute(
            "SELECT current_qty FROM products WHERE id = ? AND shop_id = ?", (product_id, shop_id)
        ).fetchone()
        if row is None:
            raise ApiError(404, "Product not found")
        diff = new_qty - as_number(row["current_qty"])
        state.db.conn.execute(
            "UPDATE products SET current_qty = ?, updated_at = datetime('now','localtime') WHERE id = ? AND shop_id = ?",
            (new_qty, product_id, shop_id),
        )
        state.db.conn.execute(
            """
            INSERT INTO stock_transactions (shop_id, product_id, type, qty, note, user_id, created_at)
            VALUES (?, ?, 'ADJUST', ?, ?, ?, datetime('now','localtime'))
            """,
            (shop_id, product_id, diff, note, user["id"]),
        )
    return json_response({"ok": True})


@route("GET", "/api/shops/:shopId/stock/low")
def api_stock_low(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    with state.db.lock:
        rows = state.db.conn.execute(
            """
            SELECT id, name, barcode, current_qty, min_qty
            FROM products
            WHERE shop_id = ? AND current_qty < min_qty
            ORDER BY (min_qty - current_qty) DESC
            """,
            (shop_id,),
        ).fetchall()
    return json_response({"ok": True, "items": rows_to_dicts(rows)})


@route("GET", "/api/shops/:shopId/stock/incoming")
def api_stock_incoming(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    query = urllib.parse.parse_qs(url.query)
    doc_date = (query.get("date") or [today_iso()])[0]
    with state.db.lock:
        rows = state.db.conn.execute(
            """
            SELECT st.id, st.created_at, st.doc_date, st.qty, st.note, st.invoice_no, st.permit_no,
                   st.vehicle_no, st.incoming_name, st.cases, st.bottles, st.source,
                   p.name AS product_name, p.barcode AS barcode, p.size AS size
            FROM stock_transactions st
            JOIN products p ON p.id = st.product_id
            WHERE st.shop_id = ? AND st.type = 'IN' AND COALESCE(st.doc_date, date(st.created_at)) = ?
            ORDER BY st.created_at DESC
            LIMIT 200
            """,
            (shop_id, doc_date),
        ).fetchall()
    return json_response({"ok": True, "date": doc_date, "rows": rows_to_dicts(rows)})


def create_bill(state: AppState, shop_id: int, user_id: int, payment_method: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    db = state.db
    with db.lock:
        try:
            db.conn.execute("BEGIN IMMEDIATE")
            counter = db.conn.execute(
                "SELECT next_bill_no FROM bill_counters WHERE shop_id = ?", (shop_id,)
            ).fetchone()
            if counter is None:
                raise ApiError(500, "Counter missing")
            bill_no = str(int(counter["next_bill_no"])).zfill(6)
            item_rows: list[dict[str, Any]] = []
            subtotal = 0.0
            for item in items:
                product_id = int(as_number(item.get("productId")))
                qty = as_number(item.get("qty", 1))
                if product_id <= 0 or qty <= 0:
                    continue
                product = db.conn.execute(
                    """
                    SELECT id, name, barcode, sale_price, cost_price, current_qty
                    FROM products
                    WHERE id = ? AND shop_id = ?
                    """,
                    (product_id, shop_id),
                ).fetchone()
                if product is None:
                    continue
                current_qty = as_number(product["current_qty"])
                if current_qty < qty:
                    raise ApiError(400, "Insufficient stock for one or more items")
                unit_price = as_number(product["sale_price"])
                cost_price = as_number(product["cost_price"])
                line_total = qty * unit_price
                subtotal += line_total
                item_rows.append(
                    {
                        "product_id": product["id"],
                        "name": product["name"],
                        "barcode": product["barcode"],
                        "qty": qty,
                        "unit_price": unit_price,
                        "cost_price": cost_price,
                        "line_total": line_total,
                        "new_qty": current_qty - qty,
                    }
                )
            if not item_rows:
                raise ApiError(400, "No items")
            total = subtotal
            if db.has_column("bills", "gst_total"):
                cur = db.conn.execute(
                    """
                    INSERT INTO bills (shop_id, bill_no, payment_method, subtotal, gst_total, total, user_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                    """,
                    (shop_id, bill_no, payment_method, subtotal, 0, total, user_id),
                )
            else:
                cur = db.conn.execute(
                    """
                    INSERT INTO bills (shop_id, bill_no, payment_method, subtotal, total, user_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
                    """,
                    (shop_id, bill_no, payment_method, subtotal, total, user_id),
                )
            bill_id = int(cur.lastrowid)
            bill_items_have_gst = db.has_column("bill_items", "gst_rate")
            for row in item_rows:
                if bill_items_have_gst:
                    db.conn.execute(
                        """
                        INSERT INTO bill_items
                          (bill_id, product_id, name_snapshot, barcode_snapshot, qty, unit_price, cost_price,
                           gst_rate, taxable_amount, gst_amount, line_total)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            bill_id,
                            row["product_id"],
                            row["name"],
                            row["barcode"],
                            row["qty"],
                            row["unit_price"],
                            row["cost_price"],
                            0,
                            row["line_total"],
                            0,
                            row["line_total"],
                        ),
                    )
                else:
                    db.conn.execute(
                        """
                        INSERT INTO bill_items
                          (bill_id, product_id, name_snapshot, barcode_snapshot, qty, unit_price, cost_price, line_total)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            bill_id,
                            row["product_id"],
                            row["name"],
                            row["barcode"],
                            row["qty"],
                            row["unit_price"],
                            row["cost_price"],
                            row["line_total"],
                        ),
                    )
                db.conn.execute(
                    "UPDATE products SET current_qty = ?, updated_at = datetime('now','localtime') WHERE id = ? AND shop_id = ?",
                    (row["new_qty"], row["product_id"], shop_id),
                )
                db.conn.execute(
                    """
                    INSERT INTO stock_transactions (shop_id, product_id, type, qty, note, reference_bill_id, user_id, created_at)
                    VALUES (?, ?, 'OUT', ?, 'Sale', ?, ?, datetime('now','localtime'))
                    """,
                    (shop_id, row["product_id"], -row["qty"], bill_id, user_id),
                )
            db.conn.execute(
                "UPDATE bill_counters SET next_bill_no = next_bill_no + 1 WHERE shop_id = ?",
                (shop_id,),
            )
            bill = db.conn.execute("SELECT * FROM bills WHERE id = ?", (bill_id,)).fetchone()
            db.conn.execute("COMMIT")
            return {"bill": row_to_dict(bill)}
        except Exception:
            db.conn.execute("ROLLBACK")
            raise


@route("POST", "/api/shops/:shopId/bills")
def api_bills_post(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    body = parse_json_body(handler) or {}
    items = body.get("items") if isinstance(body.get("items"), list) else []
    if not items:
        raise ApiError(400, "No items")
    payment_method = str(body.get("paymentMethod") or "CASH").upper()
    result = create_bill(state, shop_id, int(user["id"]), payment_method, items)
    return json_response({"ok": True, "bill": result["bill"]})


@route("GET", "/api/shops/:shopId/bills")
def api_bills_get(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    query = urllib.parse.parse_qs(url.query)
    date_from = (query.get("from") or [today_iso()])[0]
    date_to = (query.get("to") or [date_from])[0]
    with state.db.lock:
        rows = state.db.conn.execute(
            """
            SELECT id, bill_no, total, created_at, payment_method
            FROM bills
            WHERE shop_id = ? AND date(created_at) BETWEEN ? AND ?
            ORDER BY created_at DESC
            LIMIT 300
            """,
            (shop_id, date_from, date_to),
        ).fetchall()
    return json_response({"ok": True, "bills": rows_to_dicts(rows)})


@route("GET", "/api/shops/:shopId/bills/:billId")
def api_bill_get(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    bill_id = parse_id(params.get("billId"), "billId")
    state.require_shop_access(user, shop_id)
    with state.db.lock:
        bill = state.db.conn.execute(
            "SELECT * FROM bills WHERE id = ? AND shop_id = ?", (bill_id, shop_id)
        ).fetchone()
        if bill is None:
            raise ApiError(404, "Bill not found")
        items = state.db.conn.execute(
            """
            SELECT bi.*, p.category AS category, p.size AS size
            FROM bill_items bi
            JOIN products p ON p.id = bi.product_id
            WHERE bi.bill_id = ?
            ORDER BY bi.id ASC
            """,
            (bill_id,),
        ).fetchall()
    return json_response({"ok": True, "bill": row_to_dict(bill), "items": rows_to_dicts(items)})


@route("POST", "/api/shops/:shopId/expenses")
def api_expenses_post(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    body = parse_json_body(handler) or {}
    expense_date = str(body.get("expenseDate") or today_iso())
    amount = as_number(body.get("amount", 0))
    category = str(body.get("category") or "General").strip() or "General"
    note = str(body.get("note") or "").strip() or None
    if not expense_date or amount <= 0:
        raise ApiError(400, "Invalid expense")
    with state.db.lock:
        state.db.conn.execute(
            "INSERT INTO expenses (shop_id, expense_date, amount, category, note, user_id) VALUES (?, ?, ?, ?, ?, ?)",
            (shop_id, expense_date, amount, category, note, user["id"]),
        )
    return json_response({"ok": True})


@route("GET", "/api/shops/:shopId/expenses")
def api_expenses_get(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    query = urllib.parse.parse_qs(url.query)
    date_from = (query.get("from") or [today_iso()])[0]
    date_to = (query.get("to") or [date_from])[0]
    with state.db.lock:
        rows = state.db.conn.execute(
            """
            SELECT id, expense_date, amount, category, note, created_at
            FROM expenses
            WHERE shop_id = ? AND expense_date BETWEEN ? AND ?
            ORDER BY expense_date DESC, created_at DESC
            LIMIT 300
            """,
            (shop_id, date_from, date_to),
        ).fetchall()
    return json_response({"ok": True, "expenses": rows_to_dicts(rows)})


@route("POST", "/api/shops/:shopId/employees")
def api_employees_post(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    body = parse_json_body(handler) or {}
    name = str(body.get("name") or "").strip()
    if not name:
        raise ApiError(400, "Name required")
    age_raw = body.get("age")
    try:
        age = int(age_raw) if age_raw not in (None, "") else None
    except (TypeError, ValueError):
        age = None
    address = str(body.get("address") or "").strip() or None
    id_proof = str(body.get("idProof") or "").strip() or None
    experience = str(body.get("experience") or "").strip() or None
    with state.db.lock:
        state.db.conn.execute(
            "INSERT INTO employees (shop_id, name, age, address, id_proof, experience) VALUES (?, ?, ?, ?, ?, ?)",
            (shop_id, name, age, address, id_proof, experience),
        )
    return json_response({"ok": True})


@route("GET", "/api/shops/:shopId/employees")
def api_employees_get(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    shop_id = parse_id(params.get("shopId"), "shopId")
    state.require_shop_access(user, shop_id)
    with state.db.lock:
        rows = state.db.conn.execute(
            """
            SELECT id, name, age, address, id_proof, experience, created_at
            FROM employees
            WHERE shop_id = ?
            ORDER BY created_at DESC
            """,
            (shop_id,),
        ).fetchall()
    return json_response({"ok": True, "employees": rows_to_dicts(rows)})


def generate_daily_stock_sales_report(state: AppState, report_date: str | None = None, shop_id: int | None = None) -> dict[str, Any]:
    db = state.db
    report_date = report_date or today_iso()
    lines: list[dict[str, Any]] = [
        {"text": "DAILY STOCK & SALES REPORT", "bold": True, "size": 12, "align": "center"},
        {"text": f"Date: {report_date}", "bold": True, "align": "center"},
        {"text": ""},
    ]
    with db.lock:
        if shop_id:
            shops = db.conn.execute(
                "SELECT id, name, address FROM shops WHERE id = ?", (shop_id,)
            ).fetchall()
        else:
            shops = db.conn.execute("SELECT id, name, address FROM shops ORDER BY id").fetchall()

        for shop in shops:
            lines.append({"text": f"Shop: {shop['name']}", "bold": True, "size": 12})
            lines.append({"text": f"Address: {str(shop['address'] or '').strip() or '-'}"})
            lines.append({"text": ""})
            sales_row = db.conn.execute(
                "SELECT COALESCE(SUM(total), 0) AS sales_total FROM bills WHERE shop_id = ? AND date(created_at) = ?",
                (shop["id"], report_date),
            ).fetchone()
            sales_total = as_number(sales_row["sales_total"] if sales_row else 0)
            lines.append({"text": f"Sales (Daily): Rs {sales_total:.2f}"})
            lines.append({"text": ""})
            lines.append({"text": "Item-wise Stock + Incoming (Daily) - Category Wise:", "bold": True})

            widths = {
                "sno": 3,
                "name": 20,
                "ml": 7,
                "ob": 6,
                "receipts": 8,
                "total": 6,
                "sales": 6,
                "cb": 7,
                "rate": 7,
                "amount": 9,
            }
            sep = (
                "  +"
                + "+".join("-" * widths[key] for key in ["sno", "name", "ml", "ob", "receipts", "total", "sales", "cb", "rate", "amount"])
                + "+"
            )
            head = (
                f"  |{left_cell('SNO', widths['sno'])}|{left_cell('ITEM NAME', widths['name'])}|"
                f"{left_cell('ML', widths['ml'])}|{left_cell('O B', widths['ob'])}|"
                f"{left_cell('RECIEPTS', widths['receipts'])}|{left_cell('TOTAL', widths['total'])}|"
                f"{left_cell('SALES', widths['sales'])}|{left_cell('C B', widths['cb'])}|"
                f"{left_cell('RATE', widths['rate'])}|{left_cell('TOTAL AMT', widths['amount'])}|"
            )
            products = db.conn.execute(
                """
                SELECT
                  p.id, p.category, p.name, p.size, p.current_qty, p.sale_price,
                  COALESCE(inc.in_qty, 0) AS incoming_qty,
                  COALESCE(inc.in_cases, 0) AS incoming_cases,
                  COALESCE(inc.in_bottles, 0) AS incoming_bottles,
                  COALESCE(sales.sold_qty, 0) AS sold_qty
                FROM products p
                LEFT JOIN (
                  SELECT product_id,
                         COALESCE(SUM(qty), 0) AS in_qty,
                         COALESCE(SUM(COALESCE(cases, 0)), 0) AS in_cases,
                         COALESCE(SUM(COALESCE(bottles, 0)), 0) AS in_bottles
                  FROM stock_transactions
                  WHERE shop_id = ? AND type = 'IN' AND COALESCE(doc_date, date(created_at)) = ?
                  GROUP BY product_id
                ) inc ON inc.product_id = p.id
                LEFT JOIN (
                  SELECT bi.product_id, COALESCE(SUM(bi.qty), 0) AS sold_qty
                  FROM bill_items bi
                  JOIN bills b ON b.id = bi.bill_id
                  WHERE b.shop_id = ? AND date(b.created_at) = ?
                  GROUP BY bi.product_id
                ) sales ON sales.product_id = p.id
                WHERE p.shop_id = ?
                  AND NOT (p.size IS NULL AND p.current_qty = 0 AND p.min_qty = 0 AND p.barcode IS NULL)
                ORDER BY p.name COLLATE NOCASE ASC, p.size ASC
                """,
                (shop["id"], report_date, shop["id"], report_date, shop["id"]),
            ).fetchall()
            if not products:
                lines.append({"text": "  (No products yet)"})
                continue

            by_category: dict[str, list[sqlite3.Row]] = {}
            for product in products:
                by_category.setdefault(report_category_section(product["category"]), []).append(product)

            grand = {"ob": 0.0, "receipts": 0.0, "total": 0.0, "sales": 0.0, "amount": 0.0, "cases": 0, "bottles": 0}
            for category_key in REPORT_CATEGORY_ORDER:
                rows = by_category.get(category_key) or []
                if not rows:
                    continue
                lines.append({"text": f"Category: {category_label(category_key)}", "bold": True})
                lines.append({"text": sep, "bold": True, "size": 8.5})
                lines.append({"text": head, "bold": True, "size": 8.5})
                lines.append({"text": sep, "bold": True, "size": 8.5})
                cat = {"ob": 0.0, "receipts": 0.0, "total": 0.0, "sales": 0.0, "amount": 0.0, "cases": 0, "bottles": 0}
                for idx, row in enumerate(rows, start=1):
                    ob = as_number(row["current_qty"])
                    receipts = as_number(row["incoming_qty"])
                    total_qty = ob + receipts
                    sold = as_number(row["sold_qty"])
                    rate = as_number(row["sale_price"])
                    amount = total_qty * rate
                    cases = round(as_number(row["incoming_cases"]))
                    bottles = round(as_number(row["incoming_bottles"]))
                    for target in (cat, grand):
                        target["ob"] += ob
                        target["receipts"] += receipts
                        target["total"] += total_qty
                        target["sales"] += sold
                        target["amount"] += amount
                        target["cases"] += cases
                        target["bottles"] += bottles
                    name_parts = wrap_cell(row["name"], widths["name"])
                    for part_idx, part in enumerate(name_parts):
                        first = part_idx == 0
                        line = (
                            f"  |{right_cell(idx if first else '', widths['sno'])}|{left_cell(part, widths['name'])}|"
                            f"{left_cell(row['size'] if first else '', widths['ml'])}|"
                            f"{right_cell(f'{ob:.2f}' if first else '', widths['ob'])}|"
                            f"{right_cell(f'{receipts:.2f}' if first else '', widths['receipts'])}|"
                            f"{right_cell(f'{total_qty:.2f}' if first else '', widths['total'])}|"
                            f"{right_cell(f'{sold:.2f}' if first else '', widths['sales'])}|"
                            f"{right_cell(f'{cases}+{bottles}' if first else '', widths['cb'])}|"
                            f"{right_cell(f'{rate:.2f}' if first else '', widths['rate'])}|"
                            f"{right_cell(f'{amount:.2f}' if first else '', widths['amount'])}|"
                        )
                        lines.append({"text": line, "size": 8.5})
                    lines.append({"text": sep, "size": 8.5})
                cat_line = (
                    f"  |{right_cell('', widths['sno'])}|{left_cell('CAT TOTAL', widths['name'])}|"
                    f"{left_cell('', widths['ml'])}|{right_cell('{:.2f}'.format(cat['ob']), widths['ob'])}|"
                    f"{right_cell('{:.2f}'.format(cat['receipts']), widths['receipts'])}|"
                    f"{right_cell('{:.2f}'.format(cat['total']), widths['total'])}|"
                    f"{right_cell('{:.2f}'.format(cat['sales']), widths['sales'])}|"
                    f"{right_cell(str(cat['cases']) + '+' + str(cat['bottles']), widths['cb'])}|"
                    f"{right_cell('', widths['rate'])}|{right_cell('{:.2f}'.format(cat['amount']), widths['amount'])}|"
                )
                lines.append({"text": cat_line, "bold": True, "size": 8.5})
                lines.append({"text": sep, "bold": True, "size": 8.5})
                lines.append({"text": ""})
            lines.append({"text": "Grand Total (All Categories):", "bold": True})
            lines.append({"text": sep, "bold": True, "size": 8.5})
            grand_line = (
                f"  |{right_cell('', widths['sno'])}|{left_cell('GRAND TOTAL', widths['name'])}|"
                f"{left_cell('', widths['ml'])}|{right_cell('{:.2f}'.format(grand['ob']), widths['ob'])}|"
                f"{right_cell('{:.2f}'.format(grand['receipts']), widths['receipts'])}|"
                f"{right_cell('{:.2f}'.format(grand['total']), widths['total'])}|"
                f"{right_cell('{:.2f}'.format(grand['sales']), widths['sales'])}|"
                f"{right_cell(str(grand['cases']) + '+' + str(grand['bottles']), widths['cb'])}|"
                f"{right_cell('', widths['rate'])}|{right_cell('{:.2f}'.format(grand['amount']), widths['amount'])}|"
            )
            lines.append({"text": grand_line, "bold": True, "size": 8.5})
            lines.append({"text": sep, "bold": True, "size": 8.5})
            lines.append({"text": ""})
            lines.append({"text": "------------------------------------------------------------"})
            lines.append({"text": ""})

        file_name = f"{report_date.replace('-', '')}-{'shop' + str(shop_id) + '-' if shop_id else ''}{random_token(10)}.pdf"
        reports_dir = Path(env("REPORTS_DIR", str(DEFAULT_REPORTS_DIR))).expanduser()
        if not reports_dir.is_absolute():
            reports_dir = ROOT / reports_dir
        reports_dir.mkdir(parents=True, exist_ok=True)
        (reports_dir / file_name).write_bytes(pdf_from_lines("A UNIT OF SR GROUPS", lines))
        db.conn.execute(
            "INSERT INTO reports (report_date, shop_id, kind, file_name) VALUES (?, ?, 'DAILY_STOCK_SALES', ?)",
            (report_date, shop_id, file_name),
        )
    return {"fileName": file_name, "reportDate": report_date, "shopId": shop_id}


def normalize_phone_numbers(raw: str | None, default_country_code: str = "+91") -> list[str]:
    if not raw:
        return []
    out: list[str] = []
    for part in re.split(r"[,;\s]+", raw):
        digits = re.sub(r"\D+", "", part)
        if not digits:
            continue
        if len(digits) == 10:
            out.append(f"{default_country_code}{digits}")
        elif part.strip().startswith("+"):
            out.append(f"+{digits}")
        else:
            out.append(f"+{digits}")
    return out


def send_sms(to: str, body: str) -> None:
    sid = env_optional("TWILIO_ACCOUNT_SID")
    token = env_optional("TWILIO_AUTH_TOKEN")
    from_number = env_optional("TWILIO_FROM_NUMBER")
    if not sid or not token or not from_number:
        print(f"[sms dry-run] to={to} body={body}")
        return
    data = urllib.parse.urlencode({"From": from_number, "To": to, "Body": body}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
        data=data,
        method="POST",
    )
    auth = base64.b64encode(f"{sid}:{token}".encode("utf-8")).decode("ascii")
    request.add_header("Authorization", f"Basic {auth}")
    request.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
    except Exception as exc:
        print(f"[sms] failed to send to {to}: {exc}")


def send_daily_report_sms_link(file_name: str, report_date: str, shop_id: int | None) -> None:
    base_url = env("PUBLIC_BASE_URL", "http://localhost:3000").rstrip("/")
    link = f"{base_url}/reports/{file_name}" if env_bool("REPORTS_PUBLIC", True) else f"{base_url}/dashboard.html"
    default_cc = env_optional("PHONE_DEFAULT_COUNTRY_CODE") or "+91"
    body = f"SR Groups report ({report_date}) ready. Download: {link}"
    for to in normalize_phone_numbers(env_optional("DAILY_REPORT_SMS_TO"), default_cc):
        send_sms(to, body)


@route("POST", "/api/reports/daily")
def api_reports_daily(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    body = parse_json_body(handler) or {}
    query = urllib.parse.parse_qs(url.query)
    report_date = str(body.get("date") or (query.get("date") or [today_iso()])[0])
    requested_shop_id = body.get("shopId")
    try:
        requested_shop_id_int = int(requested_shop_id) if requested_shop_id not in (None, "") else None
    except (TypeError, ValueError):
        requested_shop_id_int = None
    shop_id = requested_shop_id_int if user["role"] == "OWNER" else user.get("shopId")
    report = generate_daily_stock_sales_report(state, report_date, int(shop_id) if shop_id else None)
    send_daily_report_sms_link(report["fileName"], report["reportDate"], report["shopId"])
    return json_response({"ok": True, "report": report})


@route("DELETE", "/api/reports/:reportId")
def api_reports_delete(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    report_id = parse_id(params.get("reportId"), "reportId")
    with state.db.lock:
        report = state.db.conn.execute(
            "SELECT id, shop_id, file_name FROM reports WHERE id = ?", (report_id,)
        ).fetchone()
        if report is None:
            raise ApiError(404, "Report not found")
        if user["role"] != "OWNER" and int(report["shop_id"] or 0) != int(user.get("shopId") or 0):
            raise ApiError(403, "Forbidden")
        file_name = str(report["file_name"] or "")
        if re.fullmatch(r"[A-Za-z0-9._-]+\.pdf", file_name):
            reports_dir = Path(env("REPORTS_DIR", str(DEFAULT_REPORTS_DIR))).expanduser()
            if not reports_dir.is_absolute():
                reports_dir = ROOT / reports_dir
            file_path = safe_resolve(reports_dir, "/" + file_name)
            if file_path and file_path.exists():
                file_path.unlink()
        state.db.conn.execute("DELETE FROM reports WHERE id = ?", (report_id,))
    return json_response({"ok": True})


@route("GET", "/api/reports")
def api_reports_get(state: AppState, handler: BaseHTTPRequestHandler, url, params):
    user = state.require_auth(handler)
    query = urllib.parse.parse_qs(url.query)
    shop_id_param = (query.get("shopId") or [None])[0]
    try:
        requested_shop_id = int(shop_id_param) if shop_id_param not in (None, "") else None
    except ValueError:
        requested_shop_id = None
    shop_id = requested_shop_id if user["role"] == "OWNER" else user.get("shopId")
    if user["role"] != "OWNER" and requested_shop_id is not None and requested_shop_id != user.get("shopId"):
        raise ApiError(403, "Forbidden")
    with state.db.lock:
        if shop_id:
            rows = state.db.conn.execute(
                "SELECT * FROM reports WHERE shop_id = ? ORDER BY created_at DESC LIMIT 50",
                (shop_id,),
            ).fetchall()
        else:
            rows = state.db.conn.execute(
                "SELECT * FROM reports ORDER BY created_at DESC LIMIT 50"
            ).fetchall()
    return json_response({"ok": True, "reports": rows_to_dicts(rows)})


class SRGroupsHandler(BaseHTTPRequestHandler):
    state: AppState
    server_version = "SRGroupsPython/1.0"

    def do_GET(self) -> None:
        self.handle_all()

    def do_POST(self) -> None:
        self.handle_all()

    def do_PUT(self) -> None:
        self.handle_all()

    def do_DELETE(self) -> None:
        self.handle_all()

    def do_OPTIONS(self) -> None:
        self.write_response(ResponseData(204, b"", []))

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[http] {self.address_string()} - {fmt % args}")

    def handle_all(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            response = self.dispatch(parsed)
        except ApiError as exc:
            response = error_response(exc.status, exc.message, exc.details)
        except Exception as exc:
            response = error_response(500, "Server error", str(exc))
        self.write_response(response)

    def dispatch(self, parsed: urllib.parse.ParseResult) -> ResponseData:
        path = parsed.path

        if path.startswith("/reports/"):
            file_name = path.replace("/reports/", "", 1)
            if not re.fullmatch(r"[A-Za-z0-9._-]+\.pdf", file_name):
                return not_found()
            reports_dir = Path(env("REPORTS_DIR", str(DEFAULT_REPORTS_DIR))).expanduser()
            if not reports_dir.is_absolute():
                reports_dir = ROOT / reports_dir
            file_path = safe_resolve(reports_dir, "/" + file_name)
            return self.serve_file(file_path)

        if path.startswith("/api/"):
            for candidate in ROUTES:
                params = candidate.match(self.command.upper(), path)
                if params is None:
                    continue
                return candidate.handler(self.state, self, parsed, params)
            return not_found()

        if path in PROTECTED_PAGES and self.state.get_user(self) is None:
            return redirect_response("/login.html")

        web_path = "/index.html" if path == "/" else path
        file_path = safe_resolve(WEB_ROOT, web_path)
        return self.serve_file(file_path)

    def serve_file(self, file_path: Path | None) -> ResponseData:
        if file_path is None or not file_path.exists() or not file_path.is_file():
            return not_found()
        mime, _encoding = mimetypes.guess_type(str(file_path))
        if file_path.suffix == ".js":
            mime = "application/javascript"
        elif file_path.suffix == ".css":
            mime = "text/css"
        body = file_path.read_bytes()
        return ResponseData(200, body, [("Content-Type", mime or "application/octet-stream")])

    def write_response(self, response: ResponseData) -> None:
        self.send_response(response.status)
        headers = list(response.headers)
        header_names = {name.lower() for name, _value in headers}
        if "content-length" not in header_names:
            headers.append(("Content-Length", str(len(response.body))))
        if "cache-control" not in header_names:
            headers.append(("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache"))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command.upper() != "HEAD" and response.body:
            self.wfile.write(response.body)


def seconds_until_daily_report() -> float | None:
    raw_time = env_optional("DAILY_REPORT_TIME") or "21:00"
    match = re.fullmatch(r"(\d{1,2}):(\d{2})", raw_time.strip())
    if not match:
        print(f"[reports] Invalid DAILY_REPORT_TIME='{raw_time}', scheduler disabled.")
        return None
    hour, minute = int(match.group(1)), int(match.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        print(f"[reports] Invalid DAILY_REPORT_TIME='{raw_time}', scheduler disabled.")
        return None
    now = datetime.now()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def schedule_daily_reports(state: AppState) -> None:
    delay = seconds_until_daily_report()
    if delay is None:
        return

    def run_and_reschedule() -> None:
        try:
            report = generate_daily_stock_sales_report(state, today_iso(), None)
            send_daily_report_sms_link(report["fileName"], report["reportDate"], report["shopId"])
            print(f"[reports] Generated daily report {report['fileName']}")
        except Exception as exc:
            print(f"[reports] Daily report error: {exc}")
        finally:
            schedule_daily_reports(state)

    timer = threading.Timer(delay, run_and_reschedule)
    timer.daemon = True
    timer.start()
    print(f"[reports] Next daily report scheduled in {delay / 60:.1f} minutes.")


def main() -> int:
    load_dotenv()
    db_path = Path(env("DATABASE_PATH", "./data/sr-groups.db")).expanduser()
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    db = Database(db_path)
    migrate(db)
    seed_if_needed(db)
    state = AppState(db)
    schedule_daily_reports(state)

    port = env_int("PORT", 3000)
    SRGroupsHandler.state = state
    httpd = ThreadingHTTPServer(("0.0.0.0", port), SRGroupsHandler)
    print(f"SR Groups Python server listening on http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
