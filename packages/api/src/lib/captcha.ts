/**
 * CAPTCHA verification helper (issue #108 / ADR-016 §8 anti-abuse).
 *
 * Uses hCaptcha's server-side verification endpoint. The helper fails
 * **open** in `NODE_ENV=test` (so integration tests don't need a real
 * hCaptcha account) and **closed** everywhere else — if the secret is
 * unset or the provider is unreachable, the request is rejected.
 */

import { env } from "../env.js";

export interface CaptchaResult {
  ok: boolean;
  reason?: "missing_secret" | "missing_token" | "provider_rejected" | "provider_unreachable";
}

export interface CaptchaVerifier {
  verify(token: string | undefined, ip?: string): Promise<CaptchaResult>;
}

const HCAPTCHA_URL = "https://hcaptcha.com/siteverify";

interface VerifierConfig {
  secret?: string;
  /** Inject for tests. */
  fetchImpl?: typeof fetch;
  /** Verification mode. Defaults: `disabled` in tests or when `CAPTCHA_MODE=disabled`; `prod` otherwise. */
  mode?: "disabled" | "prod";
}

/**
 * Resolve the CAPTCHA mode. Priority: explicit config > `CAPTCHA_MODE` env >
 * `NODE_ENV === "test"` default. An explicit `CAPTCHA_MODE=disabled` on a
 * staging/preview environment is logged at boot so operators see the knob.
 */
function resolveMode(configMode: VerifierConfig["mode"]): "disabled" | "prod" {
  if (configMode) return configMode;
  const envMode = process.env.CAPTCHA_MODE;
  if (envMode === "disabled" || envMode === "prod") return envMode;
  if (process.env.NODE_ENV === "test") return "disabled";
  return "prod";
}

export function createCaptchaVerifier(config: VerifierConfig = {}): CaptchaVerifier {
  const mode = resolveMode(config.mode);
  const secret = config.secret ?? env.HCAPTCHA_SECRET;
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    async verify(token, ip) {
      if (mode === "disabled") {
        // Dev / CI fail-open: accept any token, including undefined.
        return { ok: true };
      }
      if (!secret) {
        return { ok: false, reason: "missing_secret" };
      }
      if (!token) {
        return { ok: false, reason: "missing_token" };
      }
      try {
        const body = new URLSearchParams({ secret, response: token });
        if (ip) body.set("remoteip", ip);
        const res = await fetchImpl(HCAPTCHA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!res.ok) return { ok: false, reason: "provider_unreachable" };
        const json = (await res.json()) as { success: boolean };
        return json.success ? { ok: true } : { ok: false, reason: "provider_rejected" };
      } catch {
        return { ok: false, reason: "provider_unreachable" };
      }
    },
  };
}

/** Default verifier bound to the process env. */
export const defaultCaptchaVerifier = createCaptchaVerifier();
