# VayuDrishti Phase 5 f3: Citizen Photo Reports Architecture & Security Audit

## 1. Executive Summary & Objective

This document provides a comprehensive architectural specification, API contract, moderation workflow, security review, and production deployment guide for **Phase 5 Feature 3 (f3): Citizen Photo Reports**.

Citizen photo reports provide essential ground-level observational context (e.g., visual smoke plumes, localized agricultural waste burning, construction dust, industrial emissions) that complements regulatory ground monitoring.

```
[ Citizen Photo Upload ]
         │ (multipart/form-data)
         ▼
[ Magic Byte Validation & Magic Header Detection ] ──(Reject SVG, HTML, scripts, fake .jpg)
         │
         ▼
[ Server-Side Re-encoding (Sharp) ] ──(Strip ALL EXIF/GPS, resize ≤1600px, generate 320px thumb)
         │
         ▼
[ Automated Pre-checks & Deduplication ] ──(SHA-256 duplicate-hash detection, dimension sanity)
         │
         ▼
[ Storage Abstraction ] ──(Local disk dev under git-ignored dir / S3-ready interface)
         │
         ▼
[ PostgreSQL Report Metadata Store ] ──(Single Source of Truth; Initial status: PENDING)
         │
         ▼
[ Moderator Review Desk ] ──(Protected by server-side secret token; in-memory only)
         │
         ├── REJECT ──► Permanently suppressed with moderation reason (retention cleanup pruning)
         │
         └── APPROVE
               │
               ▼
[ Public Read APIs & Dashboard Map Integration ] ──(Strictly flagged as UNVERIFIED context)
```

> [!IMPORTANT]
> **Strict Model Independence**: Citizen photo reports are **CONTEXT ONLY**. They never feed PM2.5 features, the Phase 1 Calibrated Logistic Regression model, thresholds ($p \ge 0.050$), risk tiers (Nominal, Watch, Elevated, High), or Phase 2 population exposure calculations. They are strictly excluded from all training and feature extraction pipelines.

---

## 2. API Contract

All citizen report endpoints are hosted under `/api/reports`:

| Method | Endpoint | Access | Purpose |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/reports` | Public (Rate-limited) | Citizen photo upload with metadata |
| `GET` | `/api/reports` | Public | List APPROVED reports (paginated, bbox/station filters) |
| `GET` | `/api/reports/images/:filename` | Gated Public / Moderator | Serve photo or thumb: APPROVED is public; PENDING/REJECTED requires moderator token (returns 404 to public) |
| `GET` | `/api/reports/moderation/list` | Moderator Token | List reports in review queue (PENDING, REJECTED, ALL) |
| `POST` | `/api/reports/moderation/review` | Moderator Token | Approve or reject report with reason |
| `POST` | `/api/reports/moderation/cleanup` | Moderator Token | Retention cleanup: deletes expired rejected DB records & orphaned images |

### 2.1 `POST /api/reports`
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `photo`: Single image binary (JPEG, PNG, WebP; max 5 MB).
  - `category`: String enum: `'smoke' | 'dust' | 'burning' | 'industrial_emission' | 'construction_dust' | 'other'`.
  - `description`: String (max 500 characters, automatically sanitized against HTML/XSS).
  - `lat`: Decimal latitude (`[-90.0, 90.0]`).
  - `lon`: Decimal longitude (`[-180.0, 180.0]`).
  - `client_timestamp`: Optional client ISO timestamp.
  - `honeypot`: Invisible anti-bot field. Submissions with non-empty values are rejected with `400 Bad Request`.
- **Response**: `201 Created`
  ```json
  {
    "success": true,
    "report_id": "8d3e2307-2856-4c75-9c95-095906f3b063",
    "status": "PENDING",
    "message": "Citizen photo report submitted successfully. It will undergo moderation before public display.",
    "nearest_station": "Anand Vihar, Delhi - DPCC (0.3 km away)"
  }
  ```

### 2.2 `GET /api/reports`
- **Query Parameters**:
  - `stationId`: (Optional) Filter by nearest station ID.
  - `bbox`: (Optional) Bounding box `minLon,minLat,maxLon,maxLat`.
  - `limit`: (Optional, default 50, max 100).
  - `offset`: (Optional, default 0).
- **Response**: `200 OK` (Strictly `status === 'APPROVED'` reports only; PENDING/REJECTED never returned)
  ```json
  {
    "reports": [
      {
        "id": "8d3e2307-2856-4c75-9c95-095906f3b063",
        "category": "smoke",
        "description": "Heavy industrial plume near Anand Vihar boundary",
        "lat": 28.65,
        "lon": 77.23,
        "nearest_station_id": "DL001",
        "nearest_station_name": "Anand Vihar, Delhi - DPCC",
        "nearest_station_distance_km": 0.3,
        "image_url": "/api/reports/images/8d3e2307-2856-4c75-9c95-095906f3b063.jpg",
        "thumb_url": "/api/reports/images/8d3e2307-2856-4c75-9c95-095906f3b063_thumb.jpg",
        "created_at": "2026-10-01T04:10:00.000Z",
        "is_verified": false,
        "disclaimer": "Citizen unverified observation. Not used in predictive risk models."
      }
    ],
    "total": 1,
    "limit": 50,
    "offset": 0
  }
  ```

### 2.3 `GET /api/reports/images/:filename`
- **Gated Access**:
  - **APPROVED reports**: Publicly accessible. Headers: `Cache-Control: public, max-age=86400, immutable`, `X-Content-Type-Options: nosniff`.
  - **PENDING or REJECTED reports**: Accessible ONLY to authenticated moderators with `CITIZEN_REPORTS_MODERATOR_TOKEN`. Requests from unauthenticated or non-moderator callers return `404 Not Found` (hides existence of unapproved images).
- **Security**: Rejects any path traversal characters (`..`, `/`, `\`, `%00`).

### 2.4 Moderator Endpoints
- **Authentication**: `Authorization: Bearer <CITIZEN_REPORTS_MODERATOR_TOKEN>` or header `x-moderator-token`.
- **Fail Closed**: If `CITIZEN_REPORTS_MODERATOR_TOKEN` is unset on the server, all moderation endpoints return `503 Service Unavailable`. If the provided token is wrong, empty, or missing, returns `401 Unauthorized`. Constant-time comparison via `crypto.timingSafeEqual`.
- `GET /api/reports/moderation/list?status=PENDING`
- `POST /api/reports/moderation/review`
  - Body: `{"report_id": "...", "action": "APPROVE" | "REJECT", "reason": "optional reason"}`
- `POST /api/reports/moderation/cleanup?days=7`
  - Prunes expired rejected records from the database and deletes associated image/thumbnail files from disk/object storage.

---

## 3. PostgreSQL as the Single Source of Truth

### 3.1 Architecture & Production Enforcement
- **Database Backend**: PostgreSQL pooled connection via `pg.Pool` utilizing parameterized queries for all operations.
- **Connection Normalization**: `normalizeDatabaseUrl()` safely handles special characters (e.g. unencoded `?` or punctuation in database passwords) by percent-encoding credentials before URI parsing.
- **Fail-Loudly in Production**: `getCitizenReportStore()` checks `NODE_ENV === 'production'`. If `DATABASE_URL` is missing, the application terminates immediately at startup with:
  `FATAL: DATABASE_URL environment variable is missing in production mode. VayuDrishti requires PostgreSQL as the single source of truth for citizen reports.`
- **File Store Restriction**: `PersistentFileReportStore` is strictly restricted to unit tests and local mock harnesses. It is never used in production.

### 3.2 Migration Runner (`src/server/db/migrator.ts`)
- **Ordered & Idempotent**: Scans `migrations/*.sql` sorted alphabetically, executing pending migrations within dedicated database transactions.
- **Tracking Table**: Automatically initializes `schema_migrations` (`migration_name VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ`).
- **CLI Migration Command**: `npm run migrate` (runs `scripts/migrate.ts`).
- **Local Dev Docker**: Provided `docker-compose.yml` spins up a local PostgreSQL 16 container on port 5432 with healthchecks.

### 3.3 PostgreSQL Schema (`migrations/001_create_citizen_reports.sql`)
```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS citizen_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    category VARCHAR(50) NOT NULL CHECK (category IN ('smoke', 'dust', 'burning', 'industrial_emission', 'construction_dust', 'other')),
    description VARCHAR(500),
    lat DOUBLE PRECISION NOT NULL CHECK (lat >= -90.0 AND lat <= 90.0),
    lon DOUBLE PRECISION NOT NULL CHECK (lon >= -180.0 AND lon <= 180.0),
    nearest_station_id VARCHAR(50),
    nearest_station_name VARCHAR(150),
    nearest_station_distance_km DOUBLE PRECISION,
    image_key VARCHAR(255) NOT NULL,
    thumb_key VARCHAR(255) NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    client_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    moderated_at TIMESTAMPTZ,
    moderation_reason VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_citizen_reports_status ON citizen_reports(status);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_created_at ON citizen_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_geo ON citizen_reports(lat, lon);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_station ON citizen_reports(nearest_station_id);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_hash ON citizen_reports(content_hash);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_status_created ON citizen_reports(status, created_at DESC);
```

---

## 4. Moderation Secret Hygiene & In-Memory State

1. **Single Canonical Variable**:
   All moderation operations authenticate against `CITIZEN_REPORTS_MODERATOR_TOKEN`. Obsolete aliases (such as `MODERATOR_SECRET_KEY`) and fallback development tokens (`vayudrishti_dev_moderator_secret_2025`) have been completely purged from the codebase and build distribution.
2. **Fail Closed**:
   If the token is unset or empty, the server marks moderation unconfigured and immediately returns 503/401. It never falls back to any hard-coded default.
3. **Timing-Safe Comparison**:
   Token comparison utilizes `crypto.timingSafeEqual` with constant-time buffering, preventing timing side-channel attacks.
4. **Client Secret Hygiene**:
   `ModerationPanel.tsx` keeps the moderator token strictly in volatile component React memory (`useState`). No `localStorage` or `sessionStorage` persistence is utilized. When the browser tab is closed or reloaded, the token is cleared.

---

## 5. Security Audit Findings & Defenses

| Security Domain | Potential Threat | Mitigation Implemented |
| :--- | :--- | :--- |
| **File Upload Handling** | Malicious script disguised as image (e.g. `exploit.jpg.php`, Polyglot SVG/HTML) | Magic byte inspection (first 12 bytes); explicit SVG/XML text check; Sharp decodes and re-encodes clean raster JPEG/WebP. Original binary is never served. |
| **Orphaned File Prevention** | DB failure after file write | `handleCitizenReportsRequest` wraps DB insert in a `try/catch` block: if PostgreSQL insertion fails, both saved image files are immediately deleted from disk. |
| **Path Traversal** | Key manipulation (e.g. `../../etc/passwd`) | Strict alphanumeric UUID whitelist (`^[a-zA-Z0-9_-]+\.(jpg\|jpeg\|png\|webp)$`); resolved path boundary verification (`startsWith(baseDir)`). |
| **Stored XSS & Double Escaping** | Script injection / double-escaped entities | Descriptions are sanitized by stripping HTML `<tags>` and capping length at 500 characters. Raw text is stored in the database. HTML escaping occurs strictly at render time: React auto-escapes JSX text, and `CoverageMap.tsx` popup generation invokes `escapeHtml()`. Entities like `&` never display double-escaped (e.g. `&amp;amp;`). |
| **Denial of Service (DoS)** | Unbounded file size or upload flood | 5 MB upload stream truncation via `busboy` limits; 413 Payload Too Large response; per-IP rate limiting (5 uploads / 10 min window). |
| **Rate Limiter Proxy Safety** | IP spoofing via `X-Forwarded-For` header | Rate limiter trusts `X-Forwarded-For` **only** when `TRUST_PROXY=true` or `TRUST_PROXY=1`. Otherwise, it uses the direct socket `req.socket.remoteAddress`. In-memory limiter requires Redis or Memcached when scaling out across multiple container instances. |
| **Bot Spam** | Automated script submissions | Hidden honeypot field (`honeypot`); non-empty honeypots are dropped with 400 Bad Request. |
| **Privacy & PII Exposure** | User identity, home GPS coordinates, camera model in metadata | Server-side re-encoding strips ALL EXIF, GPSInfo, and camera tags. No reporter name, email, or phone collected. Client IP hashed with server salt and short window. |
| **MIME Sniffing** | Browser executing image as script | `X-Content-Type-Options: nosniff` header sent on all API and image routes. |

---

## 6. Test Suite & Verification Matrix

The test suite covers full end-to-end functionality across 4 automated suites (`npm test`):

1. `test:live` (`scripts/test_live_alerts.ts`):
   - 73/73 tests passing. Shipped model inference, canonical Phase 1 parameters, exact risk tiers (Nominal, Watch, Elevated, High), $pm25\_ratio\_90 = PM2.5 / 90.0$, continuous ingestion scheduler, and station exposure math.
2. `test:citizen` (`scripts/test_citizen_reports.ts`):
   - 59/59 tests passing. Unit tests covering magic-byte inspection, EXIF stripping, path traversal guards, description sanitization, geo snapping, privacy rate limiter, duplicate-hash precheck, and model independence.
3. `test:pg` (`scripts/test_postgres_store.ts`):
   - 24/24 tests passing against real PostgreSQL database. Validates insert, fetch by ID, PENDING isolation from public queries, APPROVE/REJECT transitions, content-hash deduplication, image key lookups, retention cleanup, and DB check constraints.
4. `test:http` (`scripts/test_http_integration.ts`):
   - 41/41 tests passing over real HTTP socket connections. Validates PENDING isolation from public `GET /api/reports`, gated image serving (404 public, 200 moderator), token hygiene (401 on missing/empty/wrong), approve/reject state changes, oversized 413 upload with zero orphaned files, fake JPEG/SVG 400 rejection, honeypot rejection, and 6th-request 429 rate limiting with `Retry-After`.
