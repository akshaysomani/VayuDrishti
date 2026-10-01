-- ============================================================================
-- Migration 002: Alert Delivery Schema (Phase 5 f4)
-- ============================================================================
-- Implements PostgreSQL transactional outbox pattern, recipient registry,
-- and append-only delivery audit log for authoritative alerts.

CREATE TABLE IF NOT EXISTS recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'webhook')),
    destination VARCHAR(500) NOT NULL,
    secret_key VARCHAR(255),
    scope_type VARCHAR(20) NOT NULL DEFAULT 'all' CHECK (scope_type IN ('all', 'city', 'station')),
    scope_value VARCHAR(100),
    min_tier VARCHAR(20) CHECK (min_tier IN ('WATCH', 'ELEVATED', 'HIGH')),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipients_channel_active ON recipients(channel, active);
CREATE INDEX IF NOT EXISTS idx_recipients_scope ON recipients(scope_type, scope_value);

CREATE TABLE IF NOT EXISTS alert_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id VARCHAR(50) NOT NULL,
    station_name VARCHAR(150),
    city VARCHAR(100) NOT NULL,
    probability DOUBLE PRECISION NOT NULL,
    tier VARCHAR(20) NOT NULL CHECK (tier IN ('Nominal', 'Watch', 'Elevated', 'High')),
    source_observation_timestamp TIMESTAMPTZ NOT NULL,
    model_version VARCHAR(50) NOT NULL,
    coord_quality VARCHAR(50) NOT NULL,
    expected_people_exposed DOUBLE PRECISION,
    payload JSONB NOT NULL,
    dedupe_key VARCHAR(255) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD', 'DRY_RUN')),
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_next ON alert_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_station_time ON alert_outbox(station_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON alert_outbox(created_at DESC);

CREATE TABLE IF NOT EXISTS alert_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbox_id UUID REFERENCES alert_outbox(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES recipients(id) ON DELETE SET NULL,
    channel VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'webhook')),
    recipient_destination VARCHAR(500) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('SENT', 'FAILED', 'DRY_RUN')),
    provider_response_code INT,
    provider_response_body TEXT,
    error_message TEXT,
    delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_outbox_id ON alert_deliveries(outbox_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_timestamp ON alert_deliveries(delivered_at DESC);
