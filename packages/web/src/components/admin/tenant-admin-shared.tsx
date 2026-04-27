import { Badge } from "@/components/ui/badge";

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
}

export function formatAdminDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatTenantUserName(firstName: string, lastName: string): string {
  const fullName = `${firstName} ${lastName}`.trim();
  return fullName || "—";
}

export function renderJsonPreview(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function normalizeTenantToken(value: string | null | undefined): string {
  return normalizeToken(value);
}

export function TenantStatusBadge({ status, label }: { status: string; label: string }) {
  const normalized = normalizeToken(status);
  const variant: BadgeVariant =
    normalized === "active"
      ? "success"
      : normalized === "suspended"
        ? "warning"
        : normalized === "archived"
          ? "error"
          : "neutral";

  return <Badge variant={variant}>{label}</Badge>;
}

export function TenantVerificationBadge({
  verifiedAt,
  verifiedLabel,
  pendingLabel,
}: {
  verifiedAt: string | null;
  verifiedLabel: string;
  pendingLabel: string;
}) {
  return verifiedAt ? (
    <Badge variant="success">{verifiedLabel}</Badge>
  ) : (
    <Badge variant="warning">{pendingLabel}</Badge>
  );
}

export function TenantOwnershipBadge({
  createdVia,
  ownershipConfirmedAt,
  confirmedLabel,
  pendingLabel,
  notApplicableLabel,
}: {
  createdVia: string;
  ownershipConfirmedAt: string | null;
  confirmedLabel: string;
  pendingLabel: string;
  notApplicableLabel: string;
}) {
  const normalized = normalizeToken(createdVia);
  if (normalized !== "self_serve") {
    return <Badge variant="neutral">{notApplicableLabel}</Badge>;
  }
  return ownershipConfirmedAt ? (
    <Badge variant="success">{confirmedLabel}</Badge>
  ) : (
    <Badge variant="warning">{pendingLabel}</Badge>
  );
}
