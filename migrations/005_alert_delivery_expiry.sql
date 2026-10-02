-- ============================================================================
-- Migration 005: Outbox Alert Expiry Hardening (Phase 5 f4)
-- ============================================================================
-- 1. Updates alert_outbox status check constraint to support terminal 'EXPIRED' status.
-- 2. Updates alert_deliveries status check constraint to support 'EXPIRED' audit logs.
-- 3. Updates alert_deliveries channel check constraint to allow 'system' channel.
-- Fully idempotent and repeatable via runDatabaseMigrations().

-- 1. alert_outbox status check constraint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'alert_outbox_status_check'
    ) THEN
        ALTER TABLE alert_outbox DROP CONSTRAINT alert_outbox_status_check;
    END IF;
END $$;

ALTER TABLE alert_outbox
    ADD CONSTRAINT alert_outbox_status_check
    CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'DEAD', 'DRY_RUN', 'EXPIRED'));

-- 2. alert_deliveries status check constraint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'alert_deliveries_status_check'
    ) THEN
        ALTER TABLE alert_deliveries DROP CONSTRAINT alert_deliveries_status_check;
    END IF;
END $$;

ALTER TABLE alert_deliveries
    ADD CONSTRAINT alert_deliveries_status_check
    CHECK (status IN ('SENT', 'FAILED', 'DRY_RUN', 'EXPIRED'));

-- 3. alert_deliveries channel check constraint (allow 'system' for internal audit records)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'alert_deliveries_channel_check'
    ) THEN
        ALTER TABLE alert_deliveries DROP CONSTRAINT alert_deliveries_channel_check;
    END IF;
END $$;

ALTER TABLE alert_deliveries
    ADD CONSTRAINT alert_deliveries_channel_check
    CHECK (channel IN ('email', 'webhook', 'system'));

-- Index on EXPIRED status for fast query filtering
CREATE INDEX IF NOT EXISTS idx_outbox_status_expired
    ON alert_outbox(status)
    WHERE status = 'EXPIRED';
