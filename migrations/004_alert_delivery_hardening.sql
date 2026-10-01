-- ============================================================================
-- Migration 004: Alert Delivery Hardening (Phase 5 f4)
-- ============================================================================
-- 1. Stuck-Sending Recovery: Adds lease_expires_at on alert_outbox for worker crash resilience.
-- 2. Soft-Delete Recipients: Adds deleted_at on recipients with partial unique index.

-- 1. Stuck-sending recovery on alert_outbox
ALTER TABLE alert_outbox ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_outbox_sending_lease
    ON alert_outbox(status, lease_expires_at)
    WHERE status = 'SENDING';

-- 2. Soft-delete on recipients
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_recipients_undeleted
    ON recipients(channel, active)
    WHERE deleted_at IS NULL;

-- 3. Partial unique index: prevent duplicate active subscriptions while permitting re-adding after soft-delete
CREATE UNIQUE INDEX IF NOT EXISTS uq_recipients_channel_dest_undeleted
    ON recipients(channel, destination)
    WHERE deleted_at IS NULL;
