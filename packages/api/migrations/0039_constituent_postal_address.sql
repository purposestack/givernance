-- Migration: 0039_constituent_postal_address
-- Epic #274 follow-up — postal address fields for window-envelope letters.
--
-- Adds five free-form columns to `constituents` so the postal-letter
-- renderer can position the recipient block in the standard French DL
-- window envelope (norme NF Z-10-011). All fields are nullable —
-- existing rows stay valid, and door-drop campaigns keep working
-- because they don't carry a recipient block at all.
--
-- Why `country_code` is `VARCHAR(2)` not an enum: ISO 3166-1 has 249
-- codes; an enum is brittle in the face of geopolitical changes (new
-- countries, dependencies) and contributes nothing the validator
-- doesn't already enforce. Same pattern as `tenants.country` already
-- in place since migration 0021.
--
-- Idempotent.

ALTER TABLE constituents
  ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS address_line2 VARCHAR(255),
  ADD COLUMN IF NOT EXISTS postal_code   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS city          VARCHAR(255),
  ADD COLUMN IF NOT EXISTS country_code  VARCHAR(2);
