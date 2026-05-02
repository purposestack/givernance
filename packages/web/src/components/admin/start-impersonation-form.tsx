"use client";

import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { createClientApiClient } from "@/lib/api/client-browser";
import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";
import { buildStepUpRedirectUrl, type StepUpRequiredResponse } from "@/lib/auth/step-up";
import { cn } from "@/lib/utils";
import {
  ImpersonationService,
  type ImpersonationTargetCandidate,
  type ImpersonationTenantOption,
} from "@/services/ImpersonationService";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const REASON_MIN_LENGTH = 20;
const SEARCH_DEBOUNCE_MS = 250;

type Mode = "delegation" | "impersonation";

/**
 * Client form to start a support session (issue #24).
 *
 * Three pickers replace the bare UUID paste:
 *   1. Tenant combobox   — narrows the candidate pool; "All tenants" =
 *      search across the whole platform.
 *   2. User combobox     — debounced search by first/last/email/UUID;
 *      shows name + email + role + tenant in each row.
 *   3. Mode + reason     — same as before.
 *
 * The tenant + user lists come from /v1/admin/impersonation/{tenants,
 * targets} so the picker can stay UI-only without leaking the broader
 * /v1/superadmin surface.
 */
export function StartImpersonationForm() {
  const t = useTranslations("admin.impersonation.new");
  const [tenant, setTenant] = useState<ImpersonationTenantOption | null>(null);
  const [target, setTarget] = useState<ImpersonationTargetCandidate | null>(null);
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState<Mode>("delegation");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!target) return;
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
        body: JSON.stringify({ targetUserId: target.id, mode, reason }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as StepUpRequiredResponse;

        // Step-up MFA required (issue #250). Send the operator through
        // /api/auth/login with `acr_values=2` so Keycloak fires the
        // Conditional-LoA sub-flow (OTP prompt). The login route persists
        // `return_to` in a cookie; the callback will land them back on
        // this page after the fresh acr=2 token is set, and they re-submit.
        // Suppressed when `step_up_required` is false (lockout case — the
        // operator is locked out, redirecting to re-auth would just loop).
        if (res.status === 401 && body.step_up_required) {
          // Reset the disabled state BEFORE the redirect so a back-button
          // / bfcache restore doesn't leave the submit button stuck on
          // "Starting…" (review I-8). The `finally` below would also
          // run, but explicit ordering avoids a race with the navigation.
          setSubmitting(false);
          setError(t("stepUpRedirecting"));
          window.location.assign(
            buildStepUpRedirectUrl(window.location.origin, "/admin/impersonation/new"),
          );
          return;
        }

        // Translated error copy for the step-up 401 lockout path
        // (review I-7) — the API's RFC 9457 `detail` field is English-
        // only since the API isn't locale-aware. The redirect branch
        // above already handles `step_up_required: true`, so this 401
        // branch is reached only when the 5-fail counter tipped.
        if (res.status === 401 && body.step_up_required === false) {
          setError(t("errorLockout"));
          return;
        }

        setError(body.detail ?? body.title ?? `Request failed: ${res.status}`);
        return;
      }

      // Fresh `givernance_jwt` cookie scoped to the target tenant — drop
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
        <Label>{t("tenantLabel")}</Label>
        <TenantPicker
          value={tenant}
          onChange={(next) => {
            setTenant(next);
            // Clear the selected user when tenant scope changes — otherwise
            // the form could submit a target that doesn't belong to the
            // currently-displayed tenant.
            setTarget(null);
          }}
        />
        <p className="text-xs text-muted-foreground">{t("tenantHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label>{t("targetLabel")}</Label>
        <TargetPicker tenantId={tenant?.id} value={target} onChange={setTarget} />
        <p className="text-xs text-muted-foreground">{t("targetHelp")}</p>
      </div>

      {target && (
        <div
          className="rounded-md border border-border bg-surface-container-low px-3 py-2 text-sm"
          aria-live="polite"
        >
          <div className="font-medium">
            {target.firstName} {target.lastName}
          </div>
          <div className="text-xs text-muted-foreground">
            {target.email} · {target.role} · {target.tenantName}
          </div>
        </div>
      )}

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
        <Button type="submit" disabled={!reasonValid || !target || submitting}>
          {submitting ? t("submitting") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

function TenantPicker({
  value,
  onChange,
}: {
  value: ImpersonationTenantOption | null;
  onChange: (t: ImpersonationTenantOption | null) => void;
}) {
  const t = useTranslations("admin.impersonation.new");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<ImpersonationTenantOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQ = useDebounced(q, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data } = await ImpersonationService.listTenants(
          createClientApiClient(),
          debouncedQ || undefined,
        );
        if (!cancelled) setOptions(data);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, debouncedQ]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-between border border-border bg-surface px-3 font-normal"
          aria-expanded={open}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value ? value.name : t("tenantPlaceholder")}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={t("tenantSearchPlaceholder")} value={q} onValueChange={setQ} />
          <CommandList>
            <CommandEmpty>{loading ? t("searching") : t("noTenants")}</CommandEmpty>
            <CommandItem
              value="__all__"
              onSelect={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              <Check
                className={cn("mr-2 h-4 w-4", value === null ? "opacity-100" : "opacity-0")}
                aria-hidden
              />
              <span>{t("tenantAllOption")}</span>
            </CommandItem>
            {options.map((opt) => (
              <CommandItem
                key={opt.id}
                value={opt.id}
                onSelect={() => {
                  onChange(opt);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-4 w-4", value?.id === opt.id ? "opacity-100" : "opacity-0")}
                  aria-hidden
                />
                <div className="flex flex-col">
                  <span className="font-medium">{opt.name}</span>
                  <span className="text-xs text-muted-foreground">{opt.slug}</span>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TargetPicker({
  tenantId,
  value,
  onChange,
}: {
  tenantId: string | undefined;
  value: ImpersonationTargetCandidate | null;
  onChange: (t: ImpersonationTargetCandidate | null) => void;
}) {
  const t = useTranslations("admin.impersonation.new");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<ImpersonationTargetCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQ = useDebounced(q, SEARCH_DEBOUNCE_MS);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data } = await ImpersonationService.searchTargets(createClientApiClient(), {
          q: debouncedQ || undefined,
          tenantId,
        });
        if (!cancelled) setOptions(data);
      } catch {
        if (!cancelled) setOptions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, debouncedQ, tenantId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="w-full justify-between border border-border bg-surface px-3 font-normal"
          aria-expanded={open}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value
              ? `${value.firstName} ${value.lastName} — ${value.email}`
              : t("targetPlaceholder")}
          </span>
          <Search className="ml-2 h-4 w-4 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={t("targetSearchPlaceholder")} value={q} onValueChange={setQ} />
          <CommandList>
            <CommandEmpty>
              {loading ? t("searching") : q.length === 0 ? t("targetSearchHint") : t("noTargets")}
            </CommandEmpty>
            {options.map((opt) => (
              <CommandItem
                key={opt.id}
                value={opt.id}
                onSelect={() => {
                  onChange(opt);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-4 w-4", value?.id === opt.id ? "opacity-100" : "opacity-0")}
                  aria-hidden
                />
                <div className="flex flex-col text-left">
                  <span className="font-medium">
                    {opt.firstName} {opt.lastName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {opt.email} · {opt.role} · {opt.tenantName}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-md border p-3",
        selected ? "border-primary bg-primary/5" : "border-border bg-surface",
      )}
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

/** Trailing-edge debounce — fires on keystroke + holds for `delay` ms. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
