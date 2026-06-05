# Runbook — Keycloak kamal-proxy route recovery

> **When to reach for this.** The staging (or prod) login screen at
> `https://auth.staging.givernance.org` returns a **404** ("The page you were
> looking for doesn't exist… If you are the application owner check the logs")
> or fails TLS with `tlsv1 alert internal error`, **right after a deploy that
> rebooted the Keycloak accessory**. The app itself (`staging.givernance.org`,
> `api.staging…`) is fine — only auth is down.

## 0. Why this exists — at a glance

The Keycloak login theme is **baked into the custom `givernance-keycloak` image**
(`infra/keycloak/Dockerfile`), so any change under `infra/keycloak/themes/` (or a
realm-JSON change) trips the `run_keycloak` gate in `.github/workflows/deploy-staging.yml`
and **reboots the Keycloak accessory**. The reboot
(`.github/actions/reboot-kamal-accessory/action.yml`) runs `kamal-proxy remove`
then `kamal accessory boot`, and the boot **re-registers** the `auth.*` route —
but that registration health-checks `/realms/master/.well-known/openid-configuration`
within kamal-proxy's deploy-timeout. Keycloak **re-imports its realm + runs
Liquibase on every boot** (`KC_IMPORT_STRATEGY=OVERWRITE_EXISTING`), so on an
unlucky cold start the endpoint isn't ready in time → the route registration
times out → `auth.staging.givernance.org` is left **un-routed** even though the
container comes up healthy seconds later.

- **Symptom**: kamal-proxy has **no row** for `givernance-keycloak` in its route
  table → 404 / TLS SNI failure on the public host. Keycloak still answers **200
  internally** the whole time.
- **First incident**: 2026-06-05, deploy `aa8f8f01` (the teal-rebrand auth-theme
  change). The deploy went **red** on the "Reboot Keycloak" step; the app rolled
  out fine, only auth was un-routed.

## 1. Confirm the diagnosis (read-only)

SSH: `ssh -i ~/.ssh/givernance-dev-scaleway root@<STAGING_VPS_IP>` (185.186.76.104).

```sh
# 1. Route table — is there a row for givernance-keycloak?
docker exec kamal-proxy kamal-proxy list
#    EXPECT a row: givernance-keycloak  auth.staging.givernance.org  …  running  yes
#    If that row is ABSENT, this runbook applies.

# 2. Keycloak is healthy INTERNALLY (proves it's a routing problem, not the theme)
KCIP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' givernance-keycloak)
curl -s -o /dev/null -w 'internal well-known -> %{http_code}\n' \
  http://$KCIP:8080/realms/master/.well-known/openid-configuration   # EXPECT 200

# 3. Public host fails (no route)
curl -s -o /dev/null -w 'public well-known -> %{http_code}\n' \
  https://auth.staging.givernance.org/realms/master/.well-known/openid-configuration   # 000/404
```

If the route row is present but the host still 404s, this is a **different**
problem — stop here and investigate kamal-proxy / DNS / cert separately.

## 2. Remediate — re-register the route

The route registration is what's missing; Keycloak is healthy, so just re-add it.
This mirrors the accessory's `proxy:` block in `config/deploy-staging.yml`.

```sh
docker exec kamal-proxy kamal-proxy deploy givernance-keycloak \
  --target givernance-keycloak:8080 \
  --host auth.staging.givernance.org \
  --tls \
  --health-check-path /realms/master/.well-known/openid-configuration \
  --deploy-timeout 90s
```

- `--target givernance-keycloak:8080` uses the container **name** (Docker DNS on
  the `kamal` network resolves it), which survives container-ID changes.
- The Let's Encrypt cert for `auth.*` is cached in kamal-proxy's state volume, so
  `--tls` reuses it (no fresh ACME round-trip on the happy path).
- If Keycloak is still booting, add `--force` to register immediately (the route
  serves 502 until KC answers, then 200) instead of waiting on the health check.

### Verify

```sh
docker exec kamal-proxy kamal-proxy list | grep givernance-keycloak   # row present, TLS yes
curl -s -o /dev/null -w '%{http_code}\n' \
  https://auth.staging.givernance.org/realms/givernance/.well-known/openid-configuration   # 200
```

End-to-end: `curl -sL -o /dev/null -w '%{http_code} %{url_effective}\n'
https://staging.givernance.org/api/auth/login` should land on the themed Keycloak
login at `auth.staging…/realms/givernance/protocol/openid-connect/auth?…` with **200**.

> ⚠️ **Do NOT re-run the failed deploy to fix this.** Re-running reboots Keycloak
> and re-triggers the same realm-import race. Re-register the route by hand (above);
> the app is already deployed.

## 3. Durable fix (shipped)

Two changes prevent recurrence:

1. **`deploy_timeout: 120`** on the `accessories.keycloak.proxy` block in
   `config/deploy-staging.yml` — gives the route registration room to outlast the
   realm import (root-cause fix).
2. **Self-healing step** in `.github/actions/reboot-kamal-accessory/action.yml` —
   after boot, if a proxied accessory's route is missing, it reboots once more via
   kamal (config-driven). No-op on the happy path; only touches accessories with a
   `proxy:` block (never postgres/redis).

When `deploy-prod.yml` lands, mirror `deploy_timeout` on the prod Keycloak proxy
block (see `docs/runbooks/launch-prod.md`).

## 4. Post-mortem log

| Date | Trigger | Symptom | Resolution | Notes |
|---|---|---|---|---|
| 2026-06-05 | Deploy `aa8f8f01` (teal-rebrand auth theme) rebooted Keycloak | `auth.staging` 404 + TLS SNI error; route absent from kamal-proxy; KC healthy internally | Manual `kamal-proxy deploy` re-register (§2) | Root-cause fix (`deploy_timeout` + self-heal) shipped same day |
