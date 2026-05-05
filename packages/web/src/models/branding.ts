/**
 * Branding / org-logo types — Epic #286.
 *
 * Mirrors the contract documented in `docs/24-org-branding.md`:
 *
 *   GET    /v1/branding/org-logo  → OrgLogo | null
 *   POST   /v1/branding/org-logo  → OrgLogoPending  (multipart upload)
 *   DELETE /v1/branding/org-logo  → 204
 *
 * The pending → ready transition is observed by polling GET; variants are
 * content-addressed in object storage and served `Cache-Control: immutable`.
 */

export type OrgLogoStatus = "pending" | "ready" | "failed";

export interface OrgLogoVariants {
  /** 128×128 — sidebar header. */
  sidebar: string;
  /** 240×240 — settings card preview, org-picker. */
  preview: string;
  /** 256×256 (or original square) — public donation page hero. */
  "public-hero": string;
  /** 600×600 px-equivalent vector — postal letter / receipt PDF letterhead. */
  "pdf-letterhead": string;
}

export interface OrgLogo {
  id: string;
  status: OrgLogoStatus;
  variants: OrgLogoVariants;
  /** Pristine source the operator uploaded. */
  originalUrl: string;
  byteSize: number;
  sourceWidth: number;
  sourceHeight: number;
  uploadedAt: string;
}

export interface OrgLogoPending {
  id: string;
  status: "pending";
  originalUrl: string;
}
