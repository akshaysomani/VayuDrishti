-- VayuDrishti Phase 5 f3: Citizen Photo Reports Migration
-- Table: citizen_reports

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

-- Performance and Query Optimization Indexes
CREATE INDEX IF NOT EXISTS idx_citizen_reports_status ON citizen_reports(status);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_created_at ON citizen_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_geo ON citizen_reports(lat, lon);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_station ON citizen_reports(nearest_station_id);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_hash ON citizen_reports(content_hash);
CREATE INDEX IF NOT EXISTS idx_citizen_reports_status_created ON citizen_reports(status, created_at DESC);

COMMENT ON TABLE citizen_reports IS 'VayuDrishti Citizen Photo Reports. Context-only ground observation telemetry. Never used in model training or risk feature vectors.';
