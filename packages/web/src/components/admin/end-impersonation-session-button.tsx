"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/**
 * Inline End/Revoke button for the admin impersonation list (issue #24).
 *
 * Calls `DELETE /v1/admin/impersonation/:sessionId`. The API decides
 * `manual` vs `revoked` from whether the caller initiated the session
 * themselves; the UI just labels both as "End".
 */
export function EndImpersonationSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const t = useTranslations("admin.impersonation");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setError(null);
    setSubmitting(true);
    try {
      const csrf = readCsrfTokenFromDocumentCookie();
      const headers: Record<string, string> = {};
      if (csrf) headers[getCsrfHeaderName()] = csrf;
      const res = await fetch(
        `${API_URL}/v1/admin/impersonation/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          credentials: "include",
          headers,
        },
      );
      if (!res.ok && res.status !== 204) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        setError(body.detail ?? `Request failed: ${res.status}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button size="sm" variant="ghost" onClick={onClick} disabled={submitting}>
        {submitting ? t("ending") : t("endSession")}
      </Button>
      {error && (
        <span className="text-xs text-error-text" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
