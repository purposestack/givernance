"use client";

import { CheckCircle2, ImagePlus, LoaderCircle, Trash2, TriangleAlert, Upload } from "lucide-react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { InitialLetterAvatar } from "@/components/branding/initial-letter-avatar";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import type { OrgLogo } from "@/models/branding";
import { BrandingService } from "@/services/BrandingService";

const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
const ACCEPTED_INPUT_ATTR = ACCEPTED_MIME_TYPES.join(",");

const MAX_RASTER_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SVG_BYTES = 1 * 1024 * 1024; // 1 MB

/**
 * Polling cadence (PR #287 review, minor 12). The previous fixed 750 ms
 * interval issued up to 80 GETs before hitting the 60s ceiling. Exponential
 * backoff capped at 5 s yields ~10 GETs across the same window — the
 * pipeline almost always finishes within the first 2-3 ticks anyway.
 */
const POLL_BASE_MS = 750;
const POLL_MAX_MS = 5_000;
/** Hard ceiling so a stuck variant render doesn't block the UI forever. */
const POLL_TIMEOUT_MS = 60_000;

function pollDelayMs(attempts: number): number {
  return Math.min(POLL_BASE_MS * 2 ** Math.min(attempts, 4), POLL_MAX_MS);
}

interface LogoUploadCardProps {
  /** Org name for the initial-letter fallback. */
  orgName: string;
  /** Stable id used to seed the fallback avatar colour. */
  tenantId?: string;
  /**
   * Org-admin gate — the API enforces this too, but hiding the controls
   * for non-admins avoids showing them an upload affordance they can't act on.
   */
  canManageBranding: boolean;
}

type CardState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "ready"; logo: OrgLogo }
  | { kind: "uploading" }
  | { kind: "processing"; pendingId: string }
  | { kind: "error"; message: string };

export function LogoUploadCard({ orgName, tenantId, canManageBranding }: LogoUploadCardProps) {
  const t = useTranslations("settings.branding");
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<CardState>({ kind: "loading" });
  const [isDragOver, setIsDragOver] = useState(false);

  // ── Initial fetch ────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const logo = await BrandingService.getOrgLogo();
        if (!active) return;
        if (logo && logo.status === "ready") {
          setState({ kind: "ready", logo });
        } else if (logo && logo.status === "pending") {
          // Mid-processing on initial load — resume the poller so the user
          // who navigated back to this page mid-upload still sees it land.
          setState({ kind: "processing", pendingId: logo.id });
        } else {
          setState({ kind: "empty" });
        }
      } catch {
        if (!active) return;
        setState({ kind: "empty" });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // ── Polling effect ──────────────────────────────────────────────────
  useEffect(() => {
    if (state.kind !== "processing") return;
    let cancelled = false;
    let attempts = 0;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const logo = await BrandingService.getOrgLogo();
        if (cancelled) return;
        if (logo && logo.status === "ready") {
          setState({ kind: "ready", logo });
          toast.success(t("success"));
          return;
        }
        if (logo && logo.status === "failed") {
          setState({ kind: "error", message: t("errors.uploadFailed") });
          return;
        }
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setState({ kind: "error", message: t("errors.uploadFailed") });
          return;
        }
        timer = setTimeout(tick, pollDelayMs(attempts));
      } catch {
        if (cancelled) return;
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setState({ kind: "error", message: t("errors.uploadFailed") });
          return;
        }
        timer = setTimeout(tick, pollDelayMs(attempts));
      }
    };

    timer = setTimeout(tick, pollDelayMs(0));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state, t]);

  // ── Validation + upload ─────────────────────────────────────────────
  const handleFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      const isSvg = file.type === "image/svg+xml";
      if (!ACCEPTED_MIME_TYPES.includes(file.type as (typeof ACCEPTED_MIME_TYPES)[number])) {
        const message = t("errors.invalidFormat");
        toast.error(message);
        setState({ kind: "error", message });
        return;
      }
      const maxBytes = isSvg ? MAX_SVG_BYTES : MAX_RASTER_BYTES;
      if (file.size > maxBytes) {
        const message = t("errors.tooLarge");
        toast.error(message);
        setState({ kind: "error", message });
        return;
      }

      setState({ kind: "uploading" });
      try {
        const pending = await BrandingService.uploadOrgLogo(file);
        setState({ kind: "processing", pendingId: pending.id });
      } catch (err) {
        const message = resolveUploadErrorMessage(err, {
          tooLarge: t("errors.tooLarge"),
          invalidFormat: t("errors.invalidFormat"),
          svgInvalid: t("errors.svgInvalid"),
          fallback: t("errors.uploadFailed"),
        });
        toast.error(message);
        setState({ kind: "error", message });
      }
    },
    [t],
  );

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Clear value so the same file picked twice still re-triggers `change`.
    event.target.value = "";
    void handleFile(file);
  };

  const onDrop = (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    if (!canManageBranding) return;
    const file = event.dataTransfer.files?.[0];
    void handleFile(file);
  };

  const onDelete = async () => {
    setState({ kind: "uploading" });
    try {
      await BrandingService.deleteOrgLogo();
      setState({ kind: "empty" });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("errors.uploadFailed");
      toast.error(message);
      setState({ kind: "error", message });
    }
  };

  const triggerPicker = () => {
    fileInputRef.current?.click();
  };

  // ── Derived UI helpers ──────────────────────────────────────────────
  const currentLogo = state.kind === "ready" ? state.logo : null;
  const isBusy = state.kind === "uploading" || state.kind === "processing";

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Preview / fallback */}
        <div className="flex shrink-0 items-center justify-center">
          {currentLogo && currentLogo.variants?.preview ? (
            <div className="relative h-24 w-24 overflow-hidden rounded-2xl border border-outline-variant bg-surface-container">
              <Image
                src={currentLogo.variants.preview.url}
                alt={t("previewAlt", { orgName })}
                fill
                sizes="96px"
                className="object-contain"
              />
            </div>
          ) : (
            <InitialLetterAvatar
              orgName={orgName}
              tenantId={tenantId}
              size="xl"
              ariaLabel={orgName}
            />
          )}
        </div>

        {/* Header + controls */}
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <h2 className="font-heading text-2xl leading-tight text-on-surface">{t("title")}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-on-surface-variant">
              {t("description")}
            </p>
          </div>

          {canManageBranding ? (
            <>
              {/* Drop zone — the entire affordance is one semantic <button>
                  (PR #287 review, minor 11). The hidden <input type="file">
                  is hoisted as a sibling so the button can stay a real
                  <button> element (browsers refuse `<button><input/></button>`
                  in some HTML5 parsers). Drag handlers work on a <button>
                  exactly the same as on a <div>. */}
              <input
                ref={fileInputRef}
                id={inputId}
                type="file"
                accept={ACCEPTED_INPUT_ATTR}
                onChange={onInputChange}
                className="sr-only"
                aria-label={t("selectFile")}
                tabIndex={-1}
              />
              <button
                type="button"
                disabled={isBusy}
                aria-controls={inputId}
                aria-label={t("dropzonePrimary")}
                onClick={triggerPicker}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!isBusy) setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={onDrop}
                className={`flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors duration-normal ease-out focus-visible:outline-none focus-visible:shadow-ring ${
                  isDragOver
                    ? "border-primary bg-primary-50/40"
                    : "border-outline-variant bg-surface"
                } ${isBusy ? "pointer-events-none opacity-60" : "cursor-pointer hover:border-primary"}`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-container text-on-primary-container">
                  <ImagePlus size={20} aria-hidden="true" />
                </span>
                <span className="space-y-1">
                  <span className="block font-medium text-on-surface">{t("dropzonePrimary")}</span>
                  <span className="block text-xs text-on-surface-variant">
                    {t("dropzoneSecondary")}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-container-low px-3 py-1 text-xs font-medium text-on-surface">
                  <Upload size={14} aria-hidden="true" />
                  {currentLogo ? t("replace") : t("selectFile")}
                </span>
              </button>

              <p className="text-xs text-on-surface-variant">{t("coachingCopy")}</p>

              {/* Status row */}
              {state.kind === "uploading" ? (
                <div
                  className="flex items-center gap-2 text-sm text-on-surface-variant"
                  role="status"
                >
                  <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                  <span>{t("uploading")}</span>
                </div>
              ) : null}
              {state.kind === "processing" ? (
                <div
                  className="flex items-center gap-2 text-sm text-on-surface-variant"
                  role="status"
                  aria-live="polite"
                >
                  <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
                  <span>{t("pendingProcessing")}</span>
                </div>
              ) : null}
              {state.kind === "ready" ? (
                <div
                  className="inline-flex items-center gap-2 rounded-full bg-green-light px-3 py-1 text-xs text-green-text"
                  role="status"
                >
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>{t("readyBadge")}</span>
                </div>
              ) : null}
              {state.kind === "error" ? (
                <div
                  className="flex items-start gap-2 rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
                  role="alert"
                  aria-live="polite"
                >
                  <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{state.message}</span>
                </div>
              ) : null}

              {currentLogo ? (
                <div className="flex flex-wrap gap-3 pt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onDelete}
                    disabled={isBusy}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t("remove")}
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <p className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-xs text-on-surface-variant">
              {t("readonlyHint")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

interface UploadErrorMessages {
  tooLarge: string;
  invalidFormat: string;
  svgInvalid: string;
  fallback: string;
}

function resolveUploadErrorMessage(error: unknown, messages: UploadErrorMessages): string {
  if (error instanceof ApiProblem) {
    // Prefer a server-provided detail string when available — it's already
    // localised for the operator's locale by the API.
    if (error.status === 413) return messages.tooLarge;
    if (error.status === 415) return messages.invalidFormat;
    if (error.status === 422) return messages.svgInvalid;
    if (error.detail) return error.detail;
    if (error.title) return error.title;
  }
  if (error instanceof Error && error.message) return error.message;
  return messages.fallback;
}
