"use client";

import { Banknote, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { BankAccount, BankAccountIbanKind } from "@/models/bank-account";
import { BankAccountService } from "@/services/BankAccountService";

interface BankAccountsTableProps {
  bankAccounts: BankAccount[];
  canManage: boolean;
}

/**
 * Format an IBAN for display: insert a space every 4 chars per ISO 13616
 * presentation guidance, e.g. `CH93 0076 2011 6238 5295 7`.
 */
function formatIbanForDisplay(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

const KIND_VARIANT: Record<BankAccountIbanKind, "success" | "info"> = {
  qr_iban: "success",
  iban: "info",
};

export function BankAccountsTable({ bankAccounts, canManage }: BankAccountsTableProps) {
  const router = useRouter();
  const t = useTranslations("settings.bankAccounts");
  const [accountToDelete, setAccountToDelete] = useState<BankAccount | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [_isPending, startTransition] = useTransition();

  async function confirmDelete() {
    if (!accountToDelete) return;
    setIsDeleting(true);
    try {
      await BankAccountService.deleteBankAccount(createClientApiClient(), accountToDelete.id);
      toast.success(t("actions.deleteSuccess"));
      setAccountToDelete(null);
      startTransition(() => router.refresh());
    } catch (error) {
      const message =
        error instanceof ApiProblem
          ? (error.detail ?? error.title ?? t("actions.deleteError"))
          : t("actions.deleteError");
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <div className="overflow-hidden rounded-2xl bg-surface-container-lowest shadow-card">
        <table className="w-full text-sm">
          <thead className="border-b border-outline-variant bg-surface-container">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-on-surface-variant">
                {t("table.bank")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-on-surface-variant">
                {t("table.iban")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-on-surface-variant">
                {t("table.kind")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-on-surface-variant">
                {t("table.currency")}
              </th>
              <th className="px-4 py-3 text-left font-medium text-on-surface-variant">
                {t("table.holder")}
              </th>
              <th className="px-4 py-3" aria-label={t("table.actionsLabel")} />
            </tr>
          </thead>
          <tbody>
            {bankAccounts.map((account) => (
              <tr
                key={account.id}
                className="border-b border-outline-variant last:border-b-0 hover:bg-surface-container/40"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/settings/bank-accounts/${account.id}`}
                    className="inline-flex items-center gap-2 text-on-surface hover:underline"
                  >
                    <Banknote size={16} aria-hidden="true" className="text-on-surface-variant" />
                    <span className="font-medium">{account.bankName}</span>
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-on-surface-variant">
                  {formatIbanForDisplay(account.iban)}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={KIND_VARIANT[account.ibanKind]}>
                    {t(`kind.${account.ibanKind}`)}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-on-surface">{account.currency}</td>
                <td className="px-4 py-3 text-on-surface-variant">{account.holderName}</td>
                <td className="px-4 py-3 text-right">
                  {canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("table.openActions", { name: account.bankName })}
                        >
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/settings/bank-accounts/${account.id}/edit`}>
                            <Pencil size={14} className="mr-2" aria-hidden="true" />
                            {t("actions.edit")}
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={(e) => {
                            e.preventDefault();
                            setAccountToDelete(account);
                          }}
                          className="text-error focus:text-error"
                        >
                          <Trash2 size={14} className="mr-2" aria-hidden="true" />
                          {t("actions.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog
        open={accountToDelete !== null}
        onOpenChange={(open) => !open && setAccountToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {accountToDelete
                ? t("delete.description", {
                    bankName: accountToDelete.bankName,
                    iban: formatIbanForDisplay(accountToDelete.iban),
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("delete.cancel")}</AlertDialogCancel>
            <Button type="button" variant="primary" onClick={confirmDelete} disabled={isDeleting}>
              {isDeleting ? t("delete.deleting") : t("delete.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
