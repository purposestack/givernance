"use client";

import { History, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { BulkImportDialog } from "@/components/constituents/bulk-import-dialog";
import { Button } from "@/components/ui/button";

/**
 * Client-only opener for the bulk-import dialog. Lives next to the
 * "New constituent" CTA on `/constituents`. The parent server page
 * decides whether to render this at all by reading the
 * `constituents.bulk_import` feature flag.
 */
export function BulkImportTrigger() {
  const t = useTranslations("constituents.bulkImport");
  const tHistory = useTranslations("constituents.bulkImport.history");
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button asChild variant="ghost" size="sm">
        <Link href="/constituents/bulk-import">
          <History size={16} aria-hidden="true" />
          {tHistory("title")}
        </Link>
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Upload size={16} aria-hidden="true" />
        {t("action")}
      </Button>
      <BulkImportDialog open={open} onOpenChange={setOpen} onCompleted={() => router.refresh()} />
    </>
  );
}
