"use client";

import { Loader2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { type FilterPreviewResponse, type FilterQuery, isFilterCondition } from "./filter-types";

interface FilterPreviewProps {
  query: FilterQuery;
  onPreview?: (response: FilterPreviewResponse) => void;
}

/**
 * Wire response shape for `POST /v1/constituents/filter/preview` (Epic #421).
 * The route handler wraps the result in a `data` envelope; we unwrap it
 * before mapping to the local `FilterPreviewResponse` UI model.
 */
interface PreviewApiResponse {
  data: {
    count: number;
    estimatedTime?: number;
  };
}

/**
 * Map an `ApiProblem` to a translation key under `constituents.filters.preview.errors`.
 * Falls back to a generic error key for unexpected statuses so we never render
 * raw backend strings (which may leak server-side terminology).
 */
function previewErrorKey(status: number): string {
  switch (status) {
    case 400:
      return "errors.badRequest";
    case 401:
      return "errors.unauthenticated";
    case 403:
      return "errors.forbidden";
    case 404:
      return "errors.flagDisabled";
    case 429:
      return "errors.rateLimit";
    default:
      return "error";
  }
}

/**
 * next-intl statically validates message keys at compile-time, but the
 * status→key map above produces a plain `string`. Cast once at the call
 * site — same papercut as `notification-preferences-form.tsx`. Runtime
 * safety is provided by the integration test that resolves every
 * registered key.
 */
type StrictTranslator = ReturnType<typeof useTranslations>;
function trDynamic(t: StrictTranslator, key: string): string {
  return (t as unknown as (k: string) => string)(key);
}

/**
 * Detect whether the query is "incomplete" — i.e. has a value-bearing
 * condition with a missing value. Extracted out of `useEffect` so the
 * preview hook stays under Biome's cognitive-complexity ceiling.
 */
function hasIncompleteCondition(query: FilterQuery): boolean {
  return query.conditions.some((c) => {
    if (!isFilterCondition(c)) return false;
    if (c.operator === "exists" || c.operator === "notExists") return false;
    if (Array.isArray(c.value)) {
      return c.value.some((v) => v === "" || v === null || v === undefined);
    }
    return c.value === "" || c.value === null || c.value === undefined;
  });
}

/**
 * Real-time preview of constituent count for current filter configuration.
 */
export function FilterPreview({ query, onPreview }: FilterPreviewProps) {
  const t = useTranslations("constituents.filters.preview");
  const [preview, setPreview] = useState<FilterPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const fetchPreview = async () => {
      // Skip when the query carries nothing meaningful — i.e. no conditions
      // AND no patterns (a pattern-only preset is now valid on the BE and
      // MUST trigger a preview, so we can't gate on `conditions.length` alone).
      // We also skip incomplete conditions so the preview doesn't fire mid-edit
      // with a half-typed value.
      const hasConditions = query.conditions.length > 0;
      const hasPatterns = (query.patterns?.length ?? 0) > 0;
      if ((!hasConditions && !hasPatterns) || hasIncompleteCondition(query)) {
        setPreview(null);
        return;
      }

      setLoading(true);
      try {
        const client = createClientApiClient();
        const response = await client.post<PreviewApiResponse>(
          "/v1/constituents/filter/preview",
          { query },
          { signal: controller.signal },
        );
        const mapped: FilterPreviewResponse = { count: response.data.count };
        setPreview(mapped);
        onPreview?.(mapped);
      } catch (error) {
        if (controller.signal.aborted) return;
        const message =
          error instanceof ApiProblem ? trDynamic(t, previewErrorKey(error.status)) : t("error");
        setPreview({ count: 0, error: message });
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    // Debounce the preview request
    const timeoutId = setTimeout(fetchPreview, 300);
    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [query, t, onPreview]);

  if (!preview && !loading) {
    return null;
  }

  if (loading) {
    return (
      <Alert className="bg-surface-container">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <AlertDescription>{t("loading")}</AlertDescription>
      </Alert>
    );
  }

  if (preview?.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{preview.error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="bg-primary-container border-primary-container" role="status">
      <Users className="h-4 w-4 text-on-primary-container" aria-hidden="true" />
      <AlertDescription className="text-on-primary-container font-medium">
        {t("count", { count: preview?.count || 0 })}
      </AlertDescription>
    </Alert>
  );
}
