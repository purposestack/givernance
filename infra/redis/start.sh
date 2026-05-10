#!/bin/sh
# Boot wrapper for the staging Redis accessory (Kamal — config/deploy-staging.yml).
#
# Why a wrapper instead of putting `redis-server --requirepass "$REDIS_PASSWORD"`
# directly in `cmd:` of deploy-staging.yml: kamal serialises a string-form `cmd:`
# such that any `$VAR` reference gets shell-expanded on the GH Actions runner
# BEFORE reaching docker. REDIS_PASSWORD is only injected into `.kamal/secrets`
# (i.e. into the container's env), never into the runner's shell — so the
# literal `$REDIS_PASSWORD` resolves to empty on the runner side and Redis
# boots with `--requirepass ""` (effectively unauthenticated). We discovered
# this on 2026-05-10 during the issue-#283-follow-up redis hardening; see the
# PR description for the full debug trace.
#
# Array-form `cmd:` would route through docker's exec form and dodge the
# runner-side expansion, but kamal explicitly rejects it for accessories
# (`accessories/redis/cmd: should be a string` ConfigurationError).
#
# This script is mounted via `accessories.redis.files:` and invoked as
# `sh /usr/local/bin/start-redis.sh` from the kamal config — the env var
# `REDIS_PASSWORD` is supplied by `accessories.redis.env.secret:` which
# resolves it from `.kamal/secrets` at boot time, INSIDE the container,
# where the expansion below works correctly.

set -eu

if [ -z "${REDIS_PASSWORD:-}" ]; then
  echo "[start-redis] REDIS_PASSWORD is empty — refusing to boot Redis without auth." >&2
  echo "[start-redis] Check accessories.redis.env.secret in config/deploy-staging.yml." >&2
  exit 1
fi

# `exec` makes redis-server PID 1 (proper signal handling for SIGTERM stop).
exec redis-server --requirepass "$REDIS_PASSWORD"
