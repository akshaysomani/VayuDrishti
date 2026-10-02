# Phase 5 Feature 4: Alert Delivery to Authorities Architecture & Specification Report

**Document Version:** 1.0.0  
**Project:** VayuDrishti (India Air Quality Acute Spike Observatory)  
**System Status:** Complete & Fully Passing  
**Single Source of Truth:** PostgreSQL (`alert_outbox`, `recipients`, `alert_deliveries`)  
**Security Standard:** Zero-Trust, SSRF Blocklist, Constant-Time Comparison, Fail-Closed  

---

## 1. Executive Summary

Phase 5 Feature 4 (`f4`) introduces reliable, policy-governed automated acute spike alert deliveries to municipal authorities and pollution control boards (e.g. DPCC, CPCB, MPCB, WBPCB). 

The delivery pipeline operates strictly as an asynchronous transactional outbox on top of PostgreSQL, decoupled from the live ingestion cycle:
```
Live WAQI Ingestion -> Feature Store -> Logistic Regression -> Canonical Risk Tier 
        │
        ▼
Delivery Policy Engine (Genuine inference check, Min Tier filter, 6h Cooldown, Escalation Bypass, Dedupe Key)
        │
        ▼
PostgreSQL Transactional Outbox (alert_outbox)
        │
        ▼
Background Alert Dispatcher (SELECT ... FOR UPDATE SKIP LOCKED concurrency claim)
        │
        ├──> DRY_RUN Mode: Logs DRY_RUN audit rows, suppresses external network calls
        └──> LIVE Mode:
                ├──> Webhook Channel (POST JSON + HMAC-SHA256 signature + SSRF defenses)
                └──> Email Channel (TLS SMTP via Nodemailer + Dynamic HTML Escaping)
        │
        ▼
Append-Only Audit Log (alert_deliveries)
        │
        ▼
Observatory UI Panel (Privacy-preserving telemetry, cooldown state, volatile in-memory admin console)
```

---

## 2. Core Architecture & Components

### 2.1 Database Schema & Migration (`002_create_alert_delivery.sql`)
The PostgreSQL schema consists of three dedicated tables tracked via `schema_migrations`:

1. **`recipients`**:
   - `id`: UUID primary key (`gen_random_uuid()`)
   - `name`: Human-readable authority designation (e.g., `DPCC Emergency Operations`)
   - `channel`: Channel type enum (`email`, `webhook`)
   - `destination`: Webhook URL or Email address
   - `secret_key`: Optional recipient-specific HMAC secret
   - `scope_type`: Geographic scope filter (`all`, `city`, `station`)
   - `scope_value`: Associated city name or station ID
   - `min_tier`: Recipient-specific minimum risk tier override (`WATCH`, `ELEVATED`, `HIGH`)
   - `active`: Boolean activation toggle
   - `created_at`, `updated_at`: Timestamps

2. **`alert_outbox`**:
   - `id`: UUID primary key
   - `station_id`, `station_name`, `city`: Geographic location identifiers
   - `probability`: Calibrated model risk probability ($0.0 \le p \le 1.0$)
   - `tier`: Canonical risk tier (`Watch`, `Elevated`, `High`)
   - `source_observation_timestamp`: WAQI observation timestamp
   - `model_version`: Calibration and model identifier
   - `coord_quality`: Coordinate resolution (`station`, `manual`, `suspect`, `city_point`)
   - `expected_people_exposed`: Phase 2 5km spatial population proxy
   - `payload`: Immutable JSON snapshot of the `StructuredAlertMessage`
   - `dedupe_key`: Deterministic deduplication key: `station_id:tier:source_observation_timestamp` (**UNIQUE constraint**)
   - `status`: Outbox state machine (`PENDING`, `SENDING`, `SENT`, `FAILED`, `DEAD`, `DRY_RUN`)
   - `attempts`, `max_attempts`: Retry counter and threshold
   - `next_attempt_at`: Exponential backoff timestamp
   - `last_error`: Scrubbed error diagnostic trace

3. **`alert_deliveries`**:
   - Append-only audit trail recording every delivery attempt
   - `outbox_id`, `recipient_id`, `channel`, `recipient_destination`, `status`, `provider_response_code`, `provider_response_body`, `error_message`, `delivered_at`

### 2.2 Delivery Policy Engine (`alertDeliveryPolicy.ts`)
The policy engine acts as the gatekeeper between raw model evaluations and the outbox:
1. **Genuine Model Inference Only:**
   - Immediately suppresses demo/fixture records (`is_demo === true`).
   - Immediately suppresses stale telemetry (`is_stale === true`).
   - Immediately suppresses `model_unavailable` states or incomplete feature buffers.
2. **Minimum Policy Tier:**
   - Evaluated against `ALERT_MIN_TIER` (default: `ELEVATED`, $p \ge 0.220$).
   - Respects canonical `getRiskTier()` definitions. Dashboard threshold ($p \ge 0.05$) remains untouched.
3. **Per-Station Cooldown & Escalation Bypass:**
   - 6-hour default cooldown per station.
   - If a station is in cooldown at `Elevated`, an escalation to `High` ($p \ge 0.50$) **bypasses** the cooldown window immediately.
   - Equal or lower tiers within cooldown are suppressed with descriptive audit reasoning.
4. **Deterministic Deduplication:**
   - Enforced in database via unique `dedupe_key` constraint. Overlapping scheduler cycles or restarts can never generate duplicate deliveries.
5. **Honest Disclaimers:**
   - Attaches explicit notice: *"Model-based early-warning estimate, not a confirmed measurement."*
   - Flags centroid fallback coordinates when `coord_quality` is `city_point` or `suspect`.

### 2.3 Dispatcher & Concurrency Safety (`alertDispatcher.ts`)
- Claims pending records using:
  ```sql
  SELECT id FROM alert_outbox
  WHERE status = 'PENDING' AND next_attempt_at <= NOW()
  ORDER BY next_attempt_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED;
  ```
- Guarantees that across multiple Node worker instances or clustered containers, each outbox row is claimed by exactly one dispatcher instance with zero race conditions.
- Automatic exponential backoff ($2^{\text{attempts}} \times 1\text{s}$) with transition to `DEAD` upon exceeding `max_attempts`.

### 2.4 Transmission Channels
1. **Webhook Channel (`webhookChannel.ts`):**
   - HTTP POST with `application/json` payload containing event timestamp, type, and structured alert message.
   - `X-VayuDrishti-Signature`: HMAC-SHA256 signature (`sha256=<hex>`) computed over `<timestamp>.<bodyString>`.
   - `X-VayuDrishti-Timestamp`: ISO 8601 timestamp to defend against replay attacks.
   - 5-second timeout via `AbortController`.
   - **SSRF Defenses:** Rejects all loopback addresses (`127.0.0.0/8`, `::1`, `localhost`), private networks (RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and cloud metadata services (`169.254.0.0/16`). Private targets permitted only when `ALERT_ALLOW_PRIVATE_WEBHOOKS=true` in local development/testing.
2. **Email Channel (`emailChannel.ts`):**
   - SMTP via `nodemailer` over TLS.
   - Generates dual plain-text and responsive HTML representations.
   - Strict dynamic HTML escaping via `escapeHtml()` prevents stored XSS in mail clients.
   - Automatic credential scrubbing from SMTP error messages.

---

## 3. Environment Variables & Configuration

| Variable | Type | Default | Description |
|---|---|---|---|
| `ALERT_DELIVERY_MODE` | String | `dry_run` | `dry_run` (simulates without network send) or `live` (transmits externally) |
| `ALERT_MIN_TIER` | String | `ELEVATED` | Minimum risk tier triggering alert delivery (`WATCH`, `ELEVATED`, or `HIGH`) |
| `ALERT_ADMIN_TOKEN` | Secret | *None* | Bearer secret for `/api/alerts/delivery/admin/*` endpoints. Fails closed (503) if unset. |
| `ALERT_WEBHOOK_SIGNING_SECRET` | Secret | *None* | HMAC-SHA256 secret used to compute outgoing `X-VayuDrishti-Signature` |
| `ALERT_ALLOW_PRIVATE_WEBHOOKS` | Boolean | `false` | When `true`, permits loopback/private IPs (local development & testing only) |
| `ALERT_COOLDOWN_HOURS` | Number | `6` | Hours before a station can re-alert at the same tier |
| `ALERT_MAX_ATTEMPTS` | Number | `5` | Maximum retry attempts before dead-lettering (`DEAD`) |
| `DASHBOARD_BASE_URL` | URL | `http://localhost:5173` | Base URL included in alert notifications linking back to observatory |
| `SMTP_HOST` | String | *None* | SMTP server hostname |
| `SMTP_PORT` | Number | `587` | SMTP server port |
| `SMTP_USER` | String | *None* | SMTP authentication user |
| `SMTP_PASS` | Secret | *None* | SMTP authentication password |
| `ALERT_FROM_ADDRESS` | String | *None* | RFC 5322 sender address header |

---

## 4. HTTP API Specifications

### Public Endpoints
- `GET /api/alerts/delivery/stats`:
  - Returns current mode (`dry_run` vs `live`), dispatcher heartbeat, outbox counts by status, station cooldown map, and masked recent deliveries.
  - Recipient email and webhook query parameters are strictly masked (e.g. `a***b@example.com`, `https://authority.gov.in/***`) to protect authority contact privacy.

### Admin Endpoints (Guarded by `ALERT_ADMIN_TOKEN`)
- `GET /api/alerts/delivery/admin/recipients`: List all authority recipients.
- `POST /api/alerts/delivery/admin/recipients`: Register new authority recipient.
- `PATCH /api/alerts/delivery/admin/recipients/:id`: Update recipient parameters or activate/deactivate.
- `DELETE /api/alerts/delivery/admin/recipients/:id`: Delete recipient.
- `GET /api/alerts/delivery/admin/outbox`: Inspect raw outbox queue by status.
- `POST /api/alerts/delivery/admin/test-alert`: Dispatches a synthetic alert clearly labeled `[TEST ALERT]`. Excluded from real operational outbox records.
- `POST /api/alerts/delivery/admin/retry/:id`: Queues a failed or dead-lettered item for immediate re-attempt.
- `POST /api/alerts/delivery/admin/dispatch-now`: Triggers an immediate manual dispatcher sweep.

---

## 5. Security & Privacy Review

1. **In-Memory Token Management:**
   - The UI console stores the `ALERT_ADMIN_TOKEN` strictly in volatile React component state (`useState`). It is never written to `localStorage`, `sessionStorage`, or cookies.
2. **Timing-Attack Resistance:**
   - Server-side token validation uses `crypto.timingSafeEqual()` with equal-length buffer guards.
3. **Fail-Closed Architecture:**
   - If `ALERT_ADMIN_TOKEN` is unset in production, admin endpoints return HTTP 503 Service Unavailable immediately.
4. **Credential Scrubbing:**
   - `scrubSensitiveErrorInfo()` automatically removes passwords, tokens, API keys, and connection strings from error messages before persisting to `alert_outbox.last_error`.
5. **SSRF Defense-in-Depth:**
   - Strict IP validation prevents attacker-configured webhooks from targeting internal cloud metadata services (`169.254.169.254`) or local services.
6. **Secret Handling & Credential Hygiene:**
   - **Zero-Logging Standard:** Secrets (including `ALERT_ADMIN_TOKEN`, `ALERT_WEBHOOK_SIGNING_SECRET`, `CITIZEN_REPORTS_MODERATOR_TOKEN`, and `SMTP_PASS`) must never be pasted into interactive shell commands, CLI flags, terminal logs, or version-controlled documents.
   - **Runtime Scripted Rotation:** All secret rotations must be executed using ephemeral in-memory scripts that read `.env` dynamically, generate cryptographic entropy via `crypto.randomBytes(32).toString('hex')`, rewrite `.env` in-place, and leave no secret traces or disk backup files behind.
   - **Runtime In-Memory Audits:** Leak sweeps and pattern checks must consume secret references in-memory rather than injecting literal string arguments into command lines (e.g., avoiding `Select-String -Pattern '<literal>'`).

---

## 6. Hardening Architecture & Enterprise Resilience

### 6.1 Stuck-Sending Lease & Recovery Semantics
- **Problem:** If a dispatcher instance crashes, loses network connectivity, or terminates mid-flight while processing an outbox row, the record would remain orphaned in `SENDING` status indefinitely.
- **Solution (Migration 004):**
  - Added `lease_expires_at TIMESTAMPTZ` column and partial index `idx_outbox_sending_lease` on `alert_outbox(lease_expires_at) WHERE status = 'SENDING'`.
  - When claiming a pending batch via `claimPendingOutbox()`, each claimed row has its lease set to `NOW() + INTERVAL 'ALERT_SEND_LEASE_SECONDS'` (default: 120s).
  - At the beginning of every dispatch cycle, `reclaimStuckLeases()` executes an atomic, race-safe query across the cluster:
    ```sql
    UPDATE alert_outbox
    SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
        attempts = CASE WHEN attempts >= max_attempts THEN attempts ELSE attempts + 1 END,
        next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE NOW() + (POWER(2, attempts) * INTERVAL '1 second') END,
        last_error = 'Delivery lease expired while in SENDING status; reclaimed for retry',
        lease_expires_at = NULL,
        updated_at = NOW()
    WHERE status = 'SENDING' AND lease_expires_at < NOW()
    RETURNING id, status, attempts;
    ```
  - **Delivery Semantics:** Outbox delivery guarantees **at-least-once** delivery across worker restarts or transient crashes.

### 6.2 Idempotency Keys & Receiver Guidance
- **Deterministic Key Derivation:**
  - `generateDeliveryIdempotencyKey(dedupeKey, recipientId)` produces a deterministic SHA-256 hex digest computed over `${dedupeKey}:${recipientId}`.
  - It contains zero secret data and remains identical across all retries, reclaims, and server restarts.
- **Webhook Channel:**
  - Sends `Idempotency-Key: <key>` header on every HTTP POST request.
  - Injects `delivery_id` and `idempotency_key` into the signed JSON body.
  - Both header and body fields are covered by the cryptographic signature in `X-VayuDrishti-Signature: sha256=<hmac>`.
- **Email Channel:**
  - Generates deterministic RFC 5322 header: `Message-ID: <idempotency_key@alerts.vayudrishti.org>`.
- **Guidance for Downstream Receivers & Authorities:**
  - Because delivery operates on at-least-once semantics, receiver endpoints should record incoming `Idempotency-Key` or `Message-ID` values.
  - If a message with an already-processed key is received within 24 hours, the receiver should return `200 OK` and ignore duplicate processing or dispatch.

### 6.3 Soft-Delete Recipient Lifecycle
- **Problem:** Hard-deleting authority contacts breaks foreign keys or historical audits in `alert_deliveries`.
- **Solution (Migration 004):**
  - Added `deleted_at TIMESTAMPTZ NULL` column to `recipients`.
  - Replaced global unique constraint on `(channel, destination)` with a partial unique index:
    ```sql
    CREATE UNIQUE INDEX IF NOT EXISTS uq_recipients_channel_dest_undeleted
    ON recipients(channel, destination) WHERE deleted_at IS NULL;
    ```
  - Admin `DELETE /api/alerts/delivery/admin/recipients/:id` executes soft deletion:
    ```sql
    UPDATE recipients SET deleted_at = NOW(), active = false, updated_at = NOW() WHERE id = $1;
    ```
  - Soft-deleted recipients are automatically excluded from `listRecipients()`, fan-out dispatch, and test alerts.
  - Admin `PATCH` on a soft-deleted recipient returns `409 Conflict` (cannot reactivate a soft-deleted recipient).
  - Because the unique constraint is partial (`WHERE deleted_at IS NULL`), authorities can safely re-register the same email address or webhook URL after past decommissioning.

### 6.4 Public Stats Minimization & Privacy
- **Public Surface (`GET /api/alerts/delivery/stats`):**
  - Strictly limited to high-level operational telemetry:
    ```typescript
    interface PublicRecentDelivery {
      channel: AlertChannelType;
      status: AlertDeliveryStatus;
      station: string;
      tier: AlertTier;
      timestamp: string;
    }
    ```
  - **Zero Exposure:** Never leaks recipient email addresses, webhook URLs, domain names, query strings, or authority contact names to unauthenticated callers.
- **Admin Surface (`GET /api/alerts/delivery/admin/stats` and `/admin/deliveries`):**
  - Retains full delivery audit records, recipient names, and destination logs for authorized security operators.
- **Dashboard UI (`AlertDeliveryPanel.tsx`):**
  - Unauthenticated view renders clean public delivery rows without recipient metadata.
  - Authenticated view with valid `ALERT_ADMIN_TOKEN` unlocks full destination telemetry with masked domains and management tools.

### 6.5 Ingestion Isolation (Post-Inference Hook)
- The delivery queue hook in `ingestionScheduler.ts` is invoked after WAQI observation ingestion and model inference.
- **Fault Isolation:**
  - Wrapped in a bounded `Promise.race` with a 1500ms timeout and an independent `try/catch` block.
  - Database outages, connection pool exhaustion, or outbox exceptions can **never** abort or block the ingestion loop.
  - Station telemetry and feature histories remain 100% intact even during catastrophic alert delivery infrastructure failures.
  - Errors are scrubbed for credentials before logging.

### 6.6 Startup Safety Guards & Admin Auth Throttling
- **Production Boot Safety Guards:**
  - If `NODE_ENV === 'production'` and `ALERT_ALLOW_PRIVATE_WEBHOOKS === 'true'`, the application terminates immediately with a fatal configuration error.
  - If `NODE_ENV === 'production'` and `ALERT_DELIVERY_MODE === 'live'`, the dispatcher checks for `ALERT_ADMIN_TOKEN` and `ALERT_WEBHOOK_SIGNING_SECRET`. If either is missing, it refuses to start the dispatcher and logs a fatal error, preventing unauthenticated live transmission.
- **Admin Auth Brute-Force Throttling:**
  - Failed admin authentication attempts are tracked per client key (hashed client IP respecting `TRUST_PROXY`).
  - Upon exceeding `ADMIN_AUTH_FAIL_LIMIT` (default: 10 failures in 600s), subsequent requests are rejected with `429 Too Many Requests` and `Retry-After: 600`.
  - Successful authentication is never penalized and immediately resets the client's failure counter.
  - *Multi-Instance Note:* In-memory tracking is local to the Node process; multi-container clusters behind a load balancer should utilize sticky sessions or centralized Redis rate limiting.

### 6.7 Real SMTP Sink Integration Testing
- The test harness (`scripts/test_alert_delivery.ts`) embeds a real RFC 5321 SMTP server (`smtp-server`) running on an ephemeral loopback port (`127.0.0.1`).
- Dynamically verifies:
  1. Plain-text and HTML MIME generation.
  2. Mandatory disclaimer inclusion: *"Model-based early-warning estimate, not a confirmed measurement."*
  3. Dynamic HTML escaping against injection payloads in station and city fields.
  4. Deterministic `Message-ID` header matching the idempotency specification.
  5. SMTP 550 mailbox rejection handling with backoff scheduling.
  6. Socket disconnect / unexpected termination handling without uncaught exceptions or crashes.
  7. Zero transmission during `dry_run` mode.

### 6.8 Outbox Alert Expiry & Stale Suppression Hardening
- **Motivation:**
  In real-world deployment, network partitions, provider rate limits, or server restarts can cause outbox rows to sit in the queue or retry backoff loops for many hours. Delivering an acute spike alert hours after the pollution event has subsided confuses emergency responders and damages observatory credibility.
- **Dispatcher Expiry Gate:**
  - Before every dispatch attempt (including initial attempts, exponential backoff retries, and lease-reclaimed items), the dispatcher checks the age of the original WAQI observation:
    $$\Delta t = \text{now} - \text{source\_observation\_timestamp}$$
  - If $\Delta t > \text{ALERT\_MAX\_AGE\_HOURS}$ (defaulting to the canonical constant `LIVE_ALERT_STALE_HOURS = 6` hours), transmission is strictly suppressed.
- **Terminal State `EXPIRED`:**
  - The row moves directly to terminal status `EXPIRED` in `alert_outbox`.
  - Records `last_error = "expired: source observation older than max age"`.
  - An audit record is written to `alert_deliveries` with `status = 'EXPIRED'`, `channel = 'system'`, and diagnostic error explanation.
  - Migration `005_alert_delivery_expiry.sql` updates `alert_outbox` and `alert_deliveries` check constraints idempotently to permit `EXPIRED` status and `'system'` channel.
- **Immunity from Retry and Reclamation:**
  - `claimPendingOutboxItems` filters for `status = 'PENDING' AND next_attempt_at <= NOW()`, never touching `EXPIRED` rows.
  - `reclaimStuckLeases` filters exclusively for `status = 'SENDING' AND lease_expires_at < NOW()`, never touching `EXPIRED` rows.
- **Manual Admin Override (`resend_stale=true`):**
  - Standard manual retry `POST /api/alerts/delivery/admin/retry/:id` rejects `EXPIRED` rows with `409 Conflict`.
  - If an authorized administrator passes `?resend_stale=true` (or JSON body `resend_stale: true`), the row is transitioned back to `PENDING` with `is_resend_stale = true`.
  - When dispatched, the message payload and body prominently prepend an advisory notice:
    `"Issued late: source observation at <ISO timestamp>"`.
- **Observation Age in All Alert Payloads:**
  - Every alert transmitted via Webhook or Email includes the exact source observation age:
    `"Source observation: <ISO timestamp>, <N> h ago at send time"`.
  - For webhooks, `observation_age_note` and `observation_age_hours` are included inside the signed JSON payload and covered by the HMAC-SHA256 signature in `X-VayuDrishti-Signature`.
  - For emails, the notice appears in both the plain-text preamble and the HTML header banner.
- **Privacy-Preserving Telemetry & UI:**
  - Public delivery statistics (`GET /api/alerts/delivery/stats`) and admin panel show aggregated counts for `EXPIRED`.
  - `AlertDeliveryPanel.tsx` includes a distinct slate-themed status badge for `EXPIRED` without exposing destination data or PII in unauthenticated views.


