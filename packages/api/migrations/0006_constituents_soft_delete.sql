-- Migration: 0006_constituents_soft_delete
-- Adds deleted_at column for soft-delete support on constituents

ALTER TABLE constituents ADD COLUMN deleted_at TIMESTAMPTZ;
