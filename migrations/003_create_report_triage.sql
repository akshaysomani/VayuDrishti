-- ============================================================================
-- Migration 003: AI-Assisted Citizen Report Triage (Phase 5 f3b)
-- ============================================================================
-- Advisory-only triage suggestion queue and classification records.
-- Strictly internal to moderation: never visible publicly, never feeds risk models.

CREATE TABLE IF NOT EXISTS report_triage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID NOT NULL UNIQUE REFERENCES citizen_reports(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'UNAVAILABLE')),
    model_name VARCHAR(100),
    model_version VARCHAR(50),
    suggested_label VARCHAR(50) CHECK (suggested_label IS NULL OR suggested_label IN ('smoke', 'fire', 'haze_fog', 'dust', 'clear_normal', 'not_relevant')),
    confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
    scores JSONB,
    category_mismatch BOOLEAN NOT NULL DEFAULT false,
    error TEXT,
    attempts INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_timeout_at TIMESTAMPTZ
);

-- Performance and Queue Claim Indexes
CREATE INDEX IF NOT EXISTS idx_report_triage_status ON report_triage(status);
CREATE INDEX IF NOT EXISTS idx_report_triage_report_id ON report_triage(report_id);
CREATE INDEX IF NOT EXISTS idx_report_triage_queue ON report_triage(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_report_triage_lease ON report_triage(status, lease_timeout_at);

COMMENT ON TABLE report_triage IS 'Advisory triage suggestions for citizen photo moderation. Strictly internal: never feeds predictive risk models or public views.';
