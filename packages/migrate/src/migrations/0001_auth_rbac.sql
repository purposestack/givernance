-- Migration: 0001_auth_rbac
-- Auth, RBAC, and Audit Trail foundation tables
-- Run manually or via drizzle-kit migrate

-- ─── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE user_role AS ENUM ('org_admin', 'user', 'viewer');

-- ─── Tenants ──────────────────────────────────────────────────────────────────

CREATE TABLE tenants (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  plan        VARCHAR(50)  NOT NULL DEFAULT 'starter',
  status      VARCHAR(50)  NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Users ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        VARCHAR(255) NOT NULL,
  first_name   VARCHAR(255) NOT NULL,
  last_name    VARCHAR(255) NOT NULL,
  role         user_role    NOT NULL DEFAULT 'user',
  keycloak_id  VARCHAR(255),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX users_org_id_idx ON users(org_id);
CREATE INDEX users_email_idx  ON users(email);

-- ─── Invitations ──────────────────────────────────────────────────────────────

CREATE TABLE invitations (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           VARCHAR(255) NOT NULL,
  role            user_role    NOT NULL DEFAULT 'user',
  token           UUID         NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  invited_by_id   UUID         REFERENCES users(id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ  NOT NULL,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX invitations_org_id_idx ON invitations(org_id);
CREATE INDEX invitations_token_idx  ON invitations(token);

-- ─── Audit Logs ───────────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID         NOT NULL,
  user_id        VARCHAR(255),
  action         VARCHAR(255) NOT NULL,
  resource_type  VARCHAR(100),
  resource_id    VARCHAR(255),
  old_values     JSONB,
  new_values     JSONB,
  ip_hash        VARCHAR(64),
  user_agent     TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_logs_org_id_idx  ON audit_logs(org_id);
CREATE INDEX audit_logs_user_id_idx ON audit_logs(user_id);

-- ─── RLS Policies (apply after enabling RLS on each table) ───────────────────
--
-- Enable RLS:
--   ALTER TABLE constituents ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE donations     ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE users         ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE invitations   ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE audit_logs    ENABLE ROW LEVEL SECURITY;
--
-- Example policy:
--   CREATE POLICY tenant_isolation ON constituents
--     USING (org_id = current_setting('app.current_org_id')::UUID);
--
-- Tenants table is admin-managed only — no RLS needed.
