#!/usr/bin/env bash
# Migrate the staging Postgres accessory to a new major version, in place.
#
# Phases (intended to be invoked sequentially by the migrate-staging-postgres
# workflow, with an artifact upload between `pre` and `cut`):
#
#   pre <target>     dump current PG state from the live container into
#                    /root/migrate-pg<src>-to-<tgt>-<ts>.sql on the VPS, into
#                    ./.migrate-staging-postgres/<same>.sql on the runner so
#                    the workflow can `actions/upload-artifact` it before any
#                    destructive step. Captures source policy/extension/locale
#                    state for verify to compare against. Refuses if source ≥
#                    target. Idempotent within a single run; a re-dispatch
#                    starts a fresh `pre`.
#
#   cut <target>     stop + remove the running container, rotate the
#                    host-side datadir to data-pg<src>-<ts> (NEVER deleted —
#                    rollback is a single `mv`), boot the new accessory image
#                    (the workflow yq-edits config/deploy-staging.yml on the
#                    runner first), wait for pg_isready, then restore the
#                    dump. Detects partial-failure mid-cut state on retry and
#                    resumes safely (or refuses if state is unrecognisable).
#
#   verify <target>  smoke-test: pg_isready, RLS-policy / extension /
#                    keycloak-migration counts vs. captured source, row
#                    counts on canonical app + keycloak tables, public
#                    healthchecks for api + keycloak.
#
# State persists between phases in ./.migrate-staging-postgres/state.env
# (source-able). The workflow uploads this directory as an artifact too on
# failure, so an operator can pick up where the workflow left off.
#
# Caller responsibilities (must already be true when the script runs):
#   - SSH agent configured against the staging VPS
#   - bundle exec kamal works (Gemfile.lock, ruby/bundler installed)
#   - .kamal/secrets present (setup-kamal-secrets composite action)
#   - For the `cut` phase: config/deploy-staging.yml's
#     accessories.postgres.image already edited to the target on the runner
#     (NOT committed — the workflow opens a follow-up PR with the bump
#     after verify succeeds)
#
# Pattern + rationale: ADR-023.

set -euo pipefail

PHASE="${1:-}"
TARGET_VERSION="${2:-}"

KAMAL_CONFIG="${KAMAL_CONFIG:-config/deploy-staging.yml}"
ACCESSORY="${ACCESSORY:-postgres}"
CONTAINER_NAME="givernance-${ACCESSORY}"
PG_USER="${PG_USER:-givernance}"
APP_DB="${APP_DB:-givernance_staging}"
KEYCLOAK_DB="${KEYCLOAK_DB:-givernance_keycloak}"

SMOKE_HEALTH_URL="${SMOKE_HEALTH_URL:-https://api.staging.givernance.org/healthz}"
SMOKE_KEYCLOAK_URL="${SMOKE_KEYCLOAK_URL:-https://auth.staging.givernance.org/realms/givernance/.well-known/openid-configuration}"

# Number of past per-migration dumps to keep on the VPS in /root/. Older
# ones are deleted at the end of `cut` so /root/ doesn't accumulate
# hundreds of MB across multiple cutovers.
KEEP_REMOTE_DUMPS="${KEEP_REMOTE_DUMPS:-3}"

# Curl retry budget for smoke endpoints. DNS / TLS handshakes against a
# fresh-booted Keycloak realm endpoint can spike past 10s on a small VPS.
SMOKE_RETRIES="${SMOKE_RETRIES:-3}"
SMOKE_RETRY_DELAY="${SMOKE_RETRY_DELAY:-5}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-10}"

WORKDIR="${WORKDIR:-./.migrate-staging-postgres}"
STATE_FILE="${WORKDIR}/state.env"

usage() {
  cat <<EOF >&2
Usage: $0 <pre|cut|verify> <target-major>
  e.g. $0 pre 17
       $0 cut 17
       $0 verify 17
EOF
  exit 64
}

[ -z "$PHASE" ] && usage
[ -z "$TARGET_VERSION" ] && usage
if ! [[ "$TARGET_VERSION" =~ ^[0-9]+$ ]]; then
  echo "target-major must be an integer (got: '$TARGET_VERSION')" >&2
  exit 64
fi

mkdir -p "$WORKDIR"

# Run a command on the VPS host shell. Kamal pipes stdout faithfully, which
# lets us capture the output of `docker inspect` / `cat <file>` etc.
vps_exec() {
  bundle exec kamal server exec -c "$KAMAL_CONFIG" "$1"
}

# Strip kamal's status-line prefix ("App Host: <ip>") and trailing whitespace
# so callers can use the result as a clean scalar. NOTE: this strips ALL
# whitespace via tr — only safe for values that don't contain legitimate
# internal whitespace (versions, byte counts, container names, single-token
# paths).
clean_kamal_output() {
  awk 'NF { line=$0 } END { sub(/^App Host:[[:space:]]*[0-9.]+[[:space:]]*/, "", line); print line }' \
    | tr -d '[:space:]'
}

# Defence-in-depth: BIND_PATH is captured from `docker inspect` output and
# later interpolated into shell commands run as root on the VPS. Reject any
# unexpected character class before letting it near a `mv` / `docker cp`.
validate_path() {
  local label="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "${label} is empty" >&2
    return 1
  fi
  if ! [[ "$value" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
    echo "${label} contains unexpected characters (got: '${value}')" >&2
    return 1
  fi
}

# Read the container destination of the postgres accessory's data directory
# from the kamal config so we don't hard-code `/var/lib/postgresql/data`.
# Falls back to the hardcoded value if yq can't parse the structure (rare,
# would fire only on a structural change to the kamal config).
postgres_data_destination() {
  local d
  d=$(yq -r '.accessories.postgres.directories[0]' "$KAMAL_CONFIG" 2>/dev/null || true)
  if [ -n "$d" ] && [ "$d" != "null" ]; then
    # Format is "host-path:/container-path" — take everything after the colon.
    echo "${d#*:}"
  else
    echo "/var/lib/postgresql/data"
  fi
}

# `pg_dumpall --clean --if-exists` emits DROP+CREATE+ALTER for every role,
# including the bootstrap superuser the restore is connecting as. Postgres
# refuses to drop the current user, so the restore would halt under
# `ON_ERROR_STOP=1`. Strip those three lines for ${PG_USER} before applying.
# The role itself is recreated by the postgres image entrypoint on first
# boot of the empty volume; the dump's role section is a no-op for it.
filter_bootstrap_role_in_dump() {
  local remote_path="$1"
  vps_exec "sed -i.bak -E '/^(DROP ROLE IF EXISTS|CREATE ROLE|ALTER ROLE) ${PG_USER}( |;)/d' ${remote_path}"
}

# Detect what state the staging VPS is in for the postgres accessory.
# Returns one of:
#   missing                     — no container at all
#   running-source              — container running, image is not target
#   running-target-empty        — container running, image is target, app DB has no users
#   running-target-populated    — container running, image is target, app DB populated (cut is a no-op)
detect_container_state() {
  local container_exists
  container_exists=$(vps_exec "docker ps -a --filter name=^/${CONTAINER_NAME}\$ --format '{{.Names}}'" \
    | clean_kamal_output)
  if [ -z "$container_exists" ]; then
    echo "missing"
    return
  fi

  local running_img major
  running_img=$(vps_exec "docker inspect ${CONTAINER_NAME} --format '{{.Config.Image}}'" \
    | clean_kamal_output)
  major=$(echo "$running_img" | sed -E 's|.*postgres:([0-9]+).*|\1|')

  if [ "$major" != "$TARGET_VERSION" ]; then
    echo "running-source"
    return
  fi

  # Container is at target; probe whether DBs are populated. We try `users`
  # specifically because it's small, always present after restore, and never
  # empty in any meaningful staging state. A non-numeric / error result
  # indicates the DB itself is missing — treat as empty.
  local user_count
  user_count=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc 'SELECT count(*) FROM users' 2>/dev/null || echo nodb" \
    | clean_kamal_output)
  if [[ "$user_count" =~ ^[0-9]+$ ]] && [ "$user_count" -gt 0 ]; then
    echo "running-target-populated"
  else
    echo "running-target-empty"
  fi
}

# Body of the dump-restore step. Used both in the normal cut path and in
# the partial-restore-recovery path (when the new container booted but
# the previous run's restore failed).
apply_restore() {
  local remote_dump="$1"
  local tmp_in_container="/tmp/restore-$(date -u +%s).sql"

  echo "Filtering dump to skip bootstrap-role self-conflict"
  filter_bootstrap_role_in_dump "$remote_dump"

  echo "Copying dump into ${CONTAINER_NAME} and restoring"
  vps_exec "docker cp '${remote_dump}' ${CONTAINER_NAME}:${tmp_in_container}"
  vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d postgres -v ON_ERROR_STOP=1 -f ${tmp_in_container}"
  vps_exec "docker exec ${CONTAINER_NAME} rm -f ${tmp_in_container}"
}

# Wait for pg_isready, surfacing recent docker logs on timeout. PG's first-
# start on an empty volume runs initdb + the entrypoint init scripts, which
# can edge past 60s on a small VPS.
wait_for_pg_ready() {
  local attempts=45  # ~90s budget
  local i
  for i in $(seq 1 "$attempts"); do
    if vps_exec "docker exec ${CONTAINER_NAME} pg_isready -U ${PG_USER}" >/dev/null 2>&1; then
      echo "  ready (attempt ${i})"
      return 0
    fi
    sleep 2
  done
  echo "PG${TARGET_VERSION} did not become ready within $((attempts * 2))s" >&2
  vps_exec "docker logs ${CONTAINER_NAME} --tail 100" >&2 || true
  return 1
}

case "$PHASE" in
  pre)
    SRC_VERSION=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -tAc \"SELECT (current_setting('server_version_num')::int / 10000)\"" \
      | clean_kamal_output)
    if [ -z "$SRC_VERSION" ]; then
      echo "could not detect source PG major from ${CONTAINER_NAME}" >&2
      exit 1
    fi
    if [ "$SRC_VERSION" = "$TARGET_VERSION" ]; then
      echo "source already at PG ${SRC_VERSION}; nothing to migrate"
      printf 'NOOP=1\nSRC_VERSION=%s\nTARGET_VERSION=%s\n' "$SRC_VERSION" "$TARGET_VERSION" > "$STATE_FILE"
      exit 0
    fi
    if [ "$SRC_VERSION" -gt "$TARGET_VERSION" ]; then
      echo "refuse to downgrade: source PG ${SRC_VERSION} > target PG ${TARGET_VERSION}" >&2
      exit 1
    fi

    TS="$(date -u +%Y%m%dT%H%M%SZ)"
    REMOTE_DUMP="/root/migrate-pg${SRC_VERSION}-to-${TARGET_VERSION}-${TS}.sql"
    LOCAL_DUMP="${WORKDIR}/migrate-pg${SRC_VERSION}-to-${TARGET_VERSION}-${TS}.sql"

    PG_DATA_DEST=$(postgres_data_destination)
    echo "Postgres data destination (from kamal config): ${PG_DATA_DEST}"

    BIND_PATH=$(vps_exec "docker inspect ${CONTAINER_NAME} --format '{{ range .Mounts }}{{ if eq .Destination \"${PG_DATA_DEST}\" }}{{ .Source }}{{ end }}{{ end }}'" \
      | clean_kamal_output)
    if ! validate_path "BIND_PATH" "$BIND_PATH"; then
      exit 1
    fi
    echo "Source bind path: ${BIND_PATH}"

    # Capture source-side state for verify-time regression checks. These
    # all read via the bootstrap superuser, which bypasses RLS — that's
    # intentional, we want the actual catalog state, not a tenant view.
    echo "Capturing source-side encoding / locale / policy / extension state"
    SRC_LC_COLLATE=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc 'SHOW lc_collate'" | clean_kamal_output)
    SRC_LC_CTYPE=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc 'SHOW lc_ctype'" | clean_kamal_output)
    SRC_ENCODING=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc 'SHOW server_encoding'" | clean_kamal_output)
    SRC_POLICY_COUNT=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc \"SELECT count(*) FROM pg_policies WHERE schemaname='public'\"" | clean_kamal_output)
    SRC_EXTENSION_COUNT=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc \"SELECT count(*) FROM pg_extension WHERE extname IN ('pg_trgm')\"" | clean_kamal_output)
    # Keycloak (Liquibase) migration table — verify-phase asserts this
    # survived the dump intact so Keycloak doesn't re-run schema deltas.
    # Probe ${KEYCLOAK_DB} first (the ADR-017-compliant topology used in
    # docker-compose.yml). If it doesn't exist, fall back to ${APP_DB}
    # (current staging Kamal config has Keycloak co-located there per
    # `config/deploy-staging.yml:241` — pre-existing ADR-017 violation,
    # tracked separately). Sets KC_LOCATION_DB to whichever DB holds
    # `databasechangelog` so verify queries the right one.
    KC_LOCATION_DB=""
    SRC_KC_MIGRATIONS="skipped"
    for candidate_db in "$KEYCLOAK_DB" "$APP_DB"; do
      probe=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${candidate_db} -tAc \"SELECT count(*) FROM databasechangelog\" 2>/dev/null || echo missing" | clean_kamal_output)
      if [[ "$probe" =~ ^[0-9]+$ ]]; then
        KC_LOCATION_DB="$candidate_db"
        SRC_KC_MIGRATIONS="$probe"
        break
      fi
    done
    if [ -z "$KC_LOCATION_DB" ]; then
      echo "  warning: keycloak databasechangelog not found in any known DB — skipping keycloak schema verify"
    fi

    echo "  lc_collate=${SRC_LC_COLLATE}, lc_ctype=${SRC_LC_CTYPE}, encoding=${SRC_ENCODING}"
    echo "  pg_policies=${SRC_POLICY_COUNT}, pg_trgm=${SRC_EXTENSION_COUNT}, keycloak_changelog=${SRC_KC_MIGRATIONS} (db=${KC_LOCATION_DB:-none})"

    if ! [[ "$SRC_POLICY_COUNT" =~ ^[0-9]+$ ]] || [ "$SRC_POLICY_COUNT" -lt 1 ]; then
      echo "source pg_policies count is '${SRC_POLICY_COUNT}' — RLS appears missing pre-migration; refusing" >&2
      exit 1
    fi

    echo "Dumping PG${SRC_VERSION} state on the VPS → ${REMOTE_DUMP}"
    # `pg_dumpall --clean --if-exists` covers all DBs + roles. The dump's
    # bootstrap-role section will be filtered just before restore (see
    # filter_bootstrap_role_in_dump).
    vps_exec "docker exec ${CONTAINER_NAME} pg_dumpall -U ${PG_USER} --clean --if-exists > ${REMOTE_DUMP}"

    REMOTE_BYTES=$(vps_exec "wc -c < ${REMOTE_DUMP}" | clean_kamal_output)
    if [ -z "$REMOTE_BYTES" ] || [ "$REMOTE_BYTES" -lt 1000 ]; then
      echo "remote dump suspiciously small (${REMOTE_BYTES:-0} bytes) — refusing to proceed" >&2
      exit 1
    fi
    echo "Remote dump size: ${REMOTE_BYTES} bytes"

    echo "Pulling dump back to runner → ${LOCAL_DUMP}"
    bundle exec kamal server exec -c "$KAMAL_CONFIG" "cat ${REMOTE_DUMP}" \
      | sed -E '1s/^App Host:[[:space:]]*[0-9.]+[[:space:]]*//' \
      > "${LOCAL_DUMP}"

    LOCAL_BYTES=$(wc -c < "${LOCAL_DUMP}" | tr -d '[:space:]')
    if [ -z "$LOCAL_BYTES" ] || [ "$LOCAL_BYTES" -lt 1000 ]; then
      echo "local dump suspiciously small (${LOCAL_BYTES:-0} bytes) — refusing to proceed" >&2
      exit 1
    fi
    echo "Local dump size:  ${LOCAL_BYTES} bytes"

    cat > "$STATE_FILE" <<EOF
NOOP=0
SRC_VERSION=${SRC_VERSION}
TARGET_VERSION=${TARGET_VERSION}
TS=${TS}
REMOTE_DUMP=${REMOTE_DUMP}
LOCAL_DUMP=${LOCAL_DUMP}
BIND_PATH=${BIND_PATH}
PG_DATA_DEST=${PG_DATA_DEST}
SRC_LC_COLLATE=${SRC_LC_COLLATE}
SRC_LC_CTYPE=${SRC_LC_CTYPE}
SRC_ENCODING=${SRC_ENCODING}
SRC_POLICY_COUNT=${SRC_POLICY_COUNT}
SRC_EXTENSION_COUNT=${SRC_EXTENSION_COUNT}
SRC_KC_MIGRATIONS=${SRC_KC_MIGRATIONS}
KC_LOCATION_DB=${KC_LOCATION_DB}
EOF

    echo ""
    echo "PRE phase complete: PG${SRC_VERSION} → PG${TARGET_VERSION}"
    echo "  remote dump: ${REMOTE_DUMP}"
    echo "  local dump:  ${LOCAL_DUMP}"
    echo "  bind path:   ${BIND_PATH}"
    ;;

  cut)
    [ ! -f "$STATE_FILE" ] && { echo "no state from pre phase at ${STATE_FILE}" >&2; exit 1; }
    # shellcheck disable=SC1090
    source "$STATE_FILE"

    if [ "${NOOP:-0}" = "1" ]; then
      echo "pre marked NOOP (already on target); skipping cut"
      exit 0
    fi

    if [ "$TARGET_VERSION" != "$2" ]; then
      echo "target mismatch: state says ${TARGET_VERSION}, arg says $2 — refusing to run" >&2
      exit 1
    fi

    if ! validate_path "BIND_PATH" "$BIND_PATH"; then
      exit 1
    fi

    # Sanity: config has been edited (by the workflow) to the target image.
    ACTUAL_IMG_LINE=$(grep -E "^[[:space:]]+image:[[:space:]]*['\"]?postgres:[0-9]+" "$KAMAL_CONFIG" | head -n1 || true)
    if [ -z "$ACTUAL_IMG_LINE" ]; then
      echo "could not find 'image: postgres:N' in ${KAMAL_CONFIG}" >&2
      exit 1
    fi
    ACTUAL_IMG_MAJOR=$(echo "$ACTUAL_IMG_LINE" | sed -E "s|.*image:[[:space:]]*['\"]?postgres:([0-9]+).*|\1|")
    if [ "$ACTUAL_IMG_MAJOR" != "$TARGET_VERSION" ]; then
      echo "${KAMAL_CONFIG} pins postgres:${ACTUAL_IMG_MAJOR}, expected postgres:${TARGET_VERSION}" >&2
      echo "  workflow must yq-edit accessories.postgres.image before invoking cut" >&2
      exit 1
    fi

    # Encoding / locale assertion. PG 17 alpine should match PG 16 alpine
    # (both glibc-free musl base, both default to C.UTF-8) but PG's
    # CREATE DATABASE in the dump carries the source's lc_collate /
    # lc_ctype literally. If the new cluster's template0 doesn't advertise
    # that locale provider, the restore halts on the first CREATE DATABASE.
    # We only assert encoding here (cheap, no SSH probe of new cluster
    # before boot); locale mismatch surfaces in the restore step.
    case "$SRC_ENCODING" in
      UTF8|UTF-8) : ;;
      *)
        echo "Source encoding is '${SRC_ENCODING}' — non-UTF8 sources are untested by this script. Bail." >&2
        exit 1
        ;;
    esac

    # ---- State detection -------------------------------------------------

    STATE=$(detect_container_state)
    echo "Container state: ${STATE}"

    PARENT_DIR="$(dirname "$BIND_PATH")"
    BIND_BASE="$(basename "$BIND_PATH")"
    ROTATED="${PARENT_DIR}/${BIND_BASE}-pg${SRC_VERSION}-${TS}"

    case "$STATE" in
      running-target-populated)
        echo "Container is already running PG${TARGET_VERSION} with populated databases."
        echo "Cut is a no-op for this dispatch — verify will run smoke tests against the existing instance."
        printf '\nALREADY_MIGRATED=1\nROTATED=%s\nRUNNING_IMG=postgres:%s\n' "(unknown — previous run)" "$TARGET_VERSION" >> "$STATE_FILE"
        exit 0
        ;;

      running-target-empty)
        # Boot succeeded on a previous run, restore failed. The remote dump
        # may or may not still exist on the VPS — re-pull from the runner-
        # local copy if needed (workflow has it in the artifact).
        echo "Resuming after partial-restore failure: container is at PG${TARGET_VERSION} but databases are empty."
        REMOTE_DUMP_EXISTS=$(vps_exec "test -f '${REMOTE_DUMP}' && echo yes || echo no" | clean_kamal_output)
        if [ "$REMOTE_DUMP_EXISTS" != "yes" ]; then
          echo "Remote dump '${REMOTE_DUMP}' is gone. Operator must re-upload from the runner artifact:" >&2
          echo "  scp '${LOCAL_DUMP}' root@${STAGING_VPS_IP:-<vps>}:${REMOTE_DUMP}" >&2
          exit 1
        fi
        apply_restore "$REMOTE_DUMP"
        printf 'RECOVERED=1\nROTATED=(prior run)\nRUNNING_IMG=postgres:%s\n' "$TARGET_VERSION" >> "$STATE_FILE"
        echo ""
        echo "CUT phase complete (partial-restore recovery): PG${TARGET_VERSION} restored from ${REMOTE_DUMP}"
        exit 0
        ;;

      missing)
        # Either we're mid-cut on retry (stop+rm + rotate happened, boot
        # failed) OR something external removed the container. Distinguish
        # by checking whether the rotated dir exists.
        ROTATED_EXISTS=$(vps_exec "test -d '${ROTATED}' && echo yes || echo no" | clean_kamal_output)
        BIND_EXISTS=$(vps_exec "test -d '${BIND_PATH}' && echo yes || echo no" | clean_kamal_output)
        if [ "$BIND_EXISTS" = "no" ] && [ "$ROTATED_EXISTS" = "no" ]; then
          echo "Inconsistent state: container missing AND no rotated datadir at '${ROTATED}'." >&2
          echo "  Refusing to run — operator must investigate manually." >&2
          exit 1
        fi
        if [ "$ROTATED_EXISTS" = "yes" ]; then
          echo "Resuming after mid-cut failure: container missing, rotation already done."
          # Skip stop/rm/rotate, jump to boot+restore.
        else
          echo "Container missing but bind path intact — performing rotation."
          vps_exec "mv '${BIND_PATH}' '${ROTATED}'"
        fi
        ;;

      running-source)
        # Normal flow.
        echo "Stopping ${CONTAINER_NAME} on VPS"
        vps_exec "docker stop ${CONTAINER_NAME} || true"
        vps_exec "docker rm ${CONTAINER_NAME} || true"
        echo "Rotating '${BIND_PATH}' → '${ROTATED}'"
        vps_exec "test -d '${BIND_PATH}' && mv '${BIND_PATH}' '${ROTATED}'"
        ;;

      *)
        echo "Unrecognised container state: '${STATE}' — refusing to run" >&2
        exit 1
        ;;
    esac

    # ---- Boot + restore --------------------------------------------------

    echo "Booting accessory ${ACCESSORY} (target image: postgres:${TARGET_VERSION})"
    bundle exec kamal accessory boot "${ACCESSORY}" -c "$KAMAL_CONFIG"

    echo "Waiting for PG${TARGET_VERSION} to accept connections"
    if ! wait_for_pg_ready; then
      exit 1
    fi

    RUNNING_IMG=$(vps_exec "docker inspect ${CONTAINER_NAME} --format '{{ .Config.Image }}'" \
      | clean_kamal_output)
    case "$RUNNING_IMG" in
      "postgres:${TARGET_VERSION}"|"postgres:${TARGET_VERSION}-alpine")
        echo "Running image confirmed: ${RUNNING_IMG}"
        ;;
      *)
        echo "running image mismatch: expected postgres:${TARGET_VERSION}*, got '${RUNNING_IMG}'" >&2
        exit 1
        ;;
    esac

    apply_restore "$REMOTE_DUMP"

    {
      echo "ROTATED=${ROTATED}"
      echo "RUNNING_IMG=${RUNNING_IMG}"
    } >> "$STATE_FILE"

    # Prune older /root/migrate-pg*.sql files on the VPS to avoid /root
    # filling up across multiple cutovers. Keeps the most recent
    # KEEP_REMOTE_DUMPS by mtime.
    vps_exec "ls -1t /root/migrate-pg*-to-*.sql 2>/dev/null | tail -n +$((KEEP_REMOTE_DUMPS + 1)) | xargs -r rm -f --" || true

    echo ""
    echo "CUT phase complete: PG${SRC_VERSION} → PG${TARGET_VERSION}"
    echo "  rotated datadir on VPS: ${ROTATED}"
    echo "  running image:          ${RUNNING_IMG}"
    echo "  rollback (manual): ssh givernance-staging; docker stop ${CONTAINER_NAME} && docker rm ${CONTAINER_NAME};"
    echo "                     mv ${ROTATED} ${BIND_PATH};"
    echo "                     # from a fresh checkout of main (NOT the runner workspace), then:"
    echo "                     bundle exec kamal accessory boot ${ACCESSORY} -c ${KAMAL_CONFIG}"
    ;;

  verify)
    [ ! -f "$STATE_FILE" ] && { echo "no state from cut phase at ${STATE_FILE}" >&2; exit 1; }
    # shellcheck disable=SC1090
    source "$STATE_FILE"

    if [ "${NOOP:-0}" = "1" ]; then
      echo "no migration was run; skipping verify"
      exit 0
    fi

    echo "1/8 pg_isready"
    vps_exec "docker exec ${CONTAINER_NAME} pg_isready -U ${PG_USER}"

    echo "2/8 row counts on canonical app tables"
    for table in users tenants donations audit_logs; do
      count=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc 'SELECT count(*) FROM ${table}'" \
        | clean_kamal_output)
      if ! [[ "$count" =~ ^[0-9]+$ ]]; then
        echo "could not query ${APP_DB}.${table} (got: '${count}')" >&2
        exit 1
      fi
      echo "  ${APP_DB}.${table}: ${count} rows"
    done

    echo "3/8 RLS policy count vs source"
    TGT_POLICY_COUNT=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc \"SELECT count(*) FROM pg_policies WHERE schemaname='public'\"" \
      | clean_kamal_output)
    if [ "$TGT_POLICY_COUNT" != "${SRC_POLICY_COUNT:-}" ]; then
      echo "  RLS regression: source had ${SRC_POLICY_COUNT:-?} policies, target has ${TGT_POLICY_COUNT}" >&2
      exit 1
    fi
    echo "  pg_policies: ${TGT_POLICY_COUNT} (matches source)"

    echo "4/8 extension count vs source"
    TGT_EXT_COUNT=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${APP_DB} -tAc \"SELECT count(*) FROM pg_extension WHERE extname IN ('pg_trgm')\"" \
      | clean_kamal_output)
    if [ "$TGT_EXT_COUNT" != "${SRC_EXTENSION_COUNT:-}" ]; then
      echo "  extension regression: source had ${SRC_EXTENSION_COUNT:-?} extensions, target has ${TGT_EXT_COUNT}" >&2
      exit 1
    fi
    echo "  pg_trgm extension count: ${TGT_EXT_COUNT} (matches source)"

    echo "5/8 keycloak realm rows"
    if [ -n "${KC_LOCATION_DB:-}" ]; then
      realm_count=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${KC_LOCATION_DB} -tAc 'SELECT count(*) FROM realm'" \
        | clean_kamal_output)
      if ! [[ "$realm_count" =~ ^[0-9]+$ ]] || [ "$realm_count" -lt 1 ]; then
        echo "  ${KC_LOCATION_DB}.realm count is '${realm_count}' (<1) — schema likely missing" >&2
        exit 1
      fi
      echo "  ${KC_LOCATION_DB}.realm: ${realm_count} rows"
    else
      echo "  KC_LOCATION_DB not set in pre — keycloak realm check skipped"
    fi

    echo "6/8 keycloak Liquibase changelog vs source"
    if [ -n "${KC_LOCATION_DB:-}" ] && [ "${SRC_KC_MIGRATIONS:-skipped}" != "skipped" ]; then
      TGT_KC_MIGRATIONS=$(vps_exec "docker exec ${CONTAINER_NAME} psql -U ${PG_USER} -d ${KC_LOCATION_DB} -tAc \"SELECT count(*) FROM databasechangelog\"" \
        | clean_kamal_output)
      if [ "$TGT_KC_MIGRATIONS" != "${SRC_KC_MIGRATIONS}" ]; then
        echo "  keycloak changelog regression: source had ${SRC_KC_MIGRATIONS} entries, target has ${TGT_KC_MIGRATIONS}" >&2
        exit 1
      fi
      echo "  ${KC_LOCATION_DB}.databasechangelog: ${TGT_KC_MIGRATIONS} rows (matches source)"
    else
      echo "  changelog check skipped (no keycloak DB found in pre)"
    fi

    echo "7/8 app healthcheck: ${SMOKE_HEALTH_URL}"
    if ! curl -fsS \
        --max-time "$SMOKE_TIMEOUT" \
        --retry "$SMOKE_RETRIES" \
        --retry-delay "$SMOKE_RETRY_DELAY" \
        --retry-connrefused \
        "${SMOKE_HEALTH_URL}" > /dev/null; then
      echo "  app healthcheck failed" >&2
      exit 1
    fi
    echo "  OK"

    echo "8/8 keycloak OIDC discovery: ${SMOKE_KEYCLOAK_URL}"
    if ! curl -fsS \
        --max-time "$SMOKE_TIMEOUT" \
        --retry "$SMOKE_RETRIES" \
        --retry-delay "$SMOKE_RETRY_DELAY" \
        --retry-connrefused \
        "${SMOKE_KEYCLOAK_URL}" > /dev/null; then
      echo "  keycloak OIDC discovery failed" >&2
      exit 1
    fi
    echo "  OK"

    # Persist a marker so a subsequent run sees that verify passed.
    echo "VERIFIED=1" >> "$STATE_FILE"

    echo ""
    echo "VERIFY phase complete: 8 smoke checks passed for PG${TARGET_VERSION}"
    ;;

  *)
    usage
    ;;
esac
