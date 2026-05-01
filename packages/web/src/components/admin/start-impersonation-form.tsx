"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const REASON_MIN_LENGTH = 20;

type Mode = "delegation" | "impersonation";

/**
 * Client form to start a support session (issue #24).
 *
 * Two modes coexist — `delegation` retains the operator's super_admin
 * powers on the target tenant; `impersonation` blocks writes and scopes
 * RBAC to the target user's role.
 */
export function StartImpersonationForm() {
  const t = useTranslations("admin.impersonation.new");
  const [targetUserId, setTargetUserId] = useState("");
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<Mode>("delegation");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const csrf = readCsrfTokenFromDocumentCookie();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (csrf) headers[getCsrfHeaderName()] = csrf;

      const res = await fetch(`${API_URL}/v1/admin/impersonation`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ targetUserId, mode, reason }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          detail?: string;
          title?: string;
        };
        setError(body.detail ?? body.title ?? `Request failed: ${res.status}`);
        return;
      }

      // The API set a fresh `givernance_jwt` cookie scoped to the target
      // tenant; the operator's normal token has been replaced. Drop them
      // straight into the target user's dashboard.
      window.location.href = "/dashboard";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  const reasonValid = reason.length >= REASON_MIN_LENGTH;

  return (
    <form className="space-y-5" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label htmlFor="targetUserId">{t("targetUserIdLabel")}</Label>
        <Input
          id="targetUserId"
          value={targetUserId}
          onChange={(e) => setTargetUserId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          required
          pattern="^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("modeLegend")}</legend>
        <div className="space-y-2">
          <ModeOption
            mode="delegation"
            current={mode}
            onSelect={setMode}
            label={t("delegationLabel")}
            help={t("delegationHelp")}
          />
          <ModeOption
            mode="impersonation"
            current={mode}
            onSelect={setMode}
            label={t("impersonationLabel")}
            help={t("impersonationHelp")}
          />
        </div>
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor="reason">{t("reasonLabel")}</Label>
        <Textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={REASON_MIN_LENGTH}
          rows={4}
          placeholder={t("reasonPlaceholder")}
        />
        <p className="text-xs text-muted-foreground">
          {t("reasonHelp", { min: REASON_MIN_LENGTH })}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-error-border bg-error-light px-3 py-2 text-sm text-error-text"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={!reasonValid || !targetUserId || submitting}>
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

function ModeOption({
  mode,
  current,
  onSelect,
  label,
  help,
}: {
  mode: Mode;
  current: Mode;
  onSelect: (m: Mode) => void;
  label: string;
  help: string;
}) {
  const selected = current === mode;
  return (
    <label
      className={[
        "flex cursor-pointer flex-col gap-1 rounded-md border p-3",
        selected ? "border-primary bg-primary/5" : "border-border bg-surface",
      ].join(" ")}
    >
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name="mode"
          value={mode}
          checked={selected}
          onChange={() => onSelect(mode)}
          className="h-4 w-4 cursor-pointer accent-primary"
        />
        <span className="font-medium">{label}</span>
      </span>
      <span className="ml-6 text-xs text-muted-foreground">{help}</span>
    </label>
  );
}
