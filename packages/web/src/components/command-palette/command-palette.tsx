"use client";

/**
 * CommandPalette — the global Cmd+K / Ctrl+K overlay (Epic #364, GLO-001).
 *
 * Mounted ONCE in `AppShell` (so the overlay is in the DOM regardless of
 * which page is current), but the trigger to *open* it is owned by the
 * shell: pressing Cmd+K (Mac) / Ctrl+K (others) anywhere in the app
 * flips `open=true`, and the topbar surfaces a visible button for
 * pointer / touch users who don't know the shortcut.
 *
 * Behaviour:
 *   - Type 2+ chars → debounced (200 ms) fetch to `GET /v1/search`.
 *     In-flight requests are aborted when a newer keystroke supersedes
 *     them, so a slow earlier response never overwrites a later one.
 *   - Results are grouped by entity type. Static "Go to …" commands
 *     and RBAC-aware quick-create actions appear when the query is
 *     empty.
 *   - Arrow keys / Enter / Esc all handled by the underlying `cmdk`
 *     primitive (which manages focus + roving tabindex + ARIA combobox
 *     roles).
 *   - On select: navigate via `next/navigation` `router.push`, then
 *     close the palette.
 *
 * a11y:
 *   - `cmdk` renders the input with role="combobox" and the list with
 *     role="listbox" by default. We add an explicit `aria-label` on the
 *     dialog so screen-readers announce "Quick search" rather than
 *     "Dialog".
 *   - The footer hint row is `aria-hidden` — it's a visual affordance
 *     for sighted users; assistive tech already knows the keys.
 */

import {
  Calendar,
  Heart,
  LayoutDashboard,
  Megaphone,
  PlusCircle,
  User as UserIcon,
  UserPlus,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  commandDialogMotion,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { createClientApiClient } from "@/lib/api/client-browser";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { type SearchGroups, type SearchHit, SearchService } from "@/services/SearchService";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;

export interface CommandPaletteProps {
  /** Controlled open state — owned by `AppShell`. */
  open: boolean;
  /** Close handler — `AppShell` flips `open` to `false`. */
  onClose: () => void;
}

const EMPTY_GROUPS: SearchGroups = {
  constituents: [],
  campaigns: [],
  donations: [],
};

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const t = useTranslations("appShell.commandPalette");
  const { hasAppRole } = useAuth();

  const canWrite = hasAppRole("org_admin") || hasAppRole("user");

  const [query, setQuery] = useState("");
  // First-keystroke latch for this open "session": the empty-state
  // mini-cascade (ADR-035 rule D16) plays only until the user starts
  // typing, so clearing the query back to empty never replays the
  // entrance (rule B12 — typing/filtering must not re-run choreography).
  const [hasTyped, setHasTyped] = useState(false);
  const [groups, setGroups] = useState<SearchGroups>(EMPTY_GROUPS);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  // Stable API client across renders. `createClientApiClient` is cheap
  // but new-ing it every render breaks the AbortController identity
  // tracking below.
  const apiClient = useMemo(() => createClientApiClient(), []);

  // Track the in-flight fetch so a later keystroke can abort an earlier
  // request — otherwise a slow first response can overwrite a fresher
  // result (classic out-of-order race).
  const inflightRef = useRef<AbortController | null>(null);

  // Reset transient state every time the palette opens — otherwise the
  // user sees stale results from the last session.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHasTyped(false);
      setGroups(EMPTY_GROUPS);
      setLoading(false);
      setErrored(false);
    }
    return () => {
      inflightRef.current?.abort();
      inflightRef.current = null;
    };
  }, [open]);

  // Debounced fetch: schedule with `setTimeout`, cancel on next keystroke.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      // Cancel any in-flight request and clear results — back to the
      // "empty query → show static commands" state.
      inflightRef.current?.abort();
      inflightRef.current = null;
      setGroups(EMPTY_GROUPS);
      setLoading(false);
      setErrored(false);
      return;
    }

    const timer = window.setTimeout(() => {
      // Supersede any prior in-flight request.
      inflightRef.current?.abort();
      const controller = new AbortController();
      inflightRef.current = controller;

      setLoading(true);
      setErrored(false);
      SearchService.search(apiClient, trimmed, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setGroups(result.groups);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // AbortError is the normal supersede path — don't flag it.
          if (err instanceof DOMException && err.name === "AbortError") return;
          setErrored(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [open, query, apiClient]);

  const handleSelect = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  const handleQueryChange = useCallback((value: string) => {
    setHasTyped(true);
    setQuery(value);
  }, []);

  // Static "Go to …" commands stay in sync with the sidebar. Keep this
  // list short — the palette is a quick-jump aid, not a sitemap.
  const navigationCommands = useMemo(
    () => [
      { id: "nav-dashboard", href: "/dashboard", label: t("nav.dashboard"), icon: LayoutDashboard },
      {
        id: "nav-constituents",
        href: "/constituents",
        label: t("nav.constituents"),
        icon: UserIcon,
      },
      { id: "nav-campaigns", href: "/campaigns", label: t("nav.campaigns"), icon: Megaphone },
      { id: "nav-donations", href: "/donations", label: t("nav.donations"), icon: Heart },
    ],
    [t],
  );

  // Quick-create actions — gated on `canWrite` so viewers don't see
  // them at all (RBAC). Each links to the existing entity-create flow;
  // we don't open a new modal here.
  const quickCreateCommands = useMemo(() => {
    if (!canWrite) return [];
    return [
      {
        id: "create-constituent",
        href: "/constituents/new",
        label: t("create.constituent"),
        icon: UserPlus,
      },
      {
        id: "create-donation",
        href: "/donations/new",
        label: t("create.donation"),
        icon: PlusCircle,
      },
      {
        id: "create-campaign",
        href: "/campaigns/new",
        label: t("create.campaign"),
        icon: Calendar,
      },
    ];
  }, [canWrite, t]);

  const hasQuery = query.trim().length >= MIN_QUERY_LENGTH;
  const hasResults =
    groups.constituents.length > 0 || groups.campaigns.length > 0 || groups.donations.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      {/* `commandDialogMotion` — ADR-035 rule D15 overlay entrance/exit
          (the stock `animate-in` classes on DialogContent are inert:
          no tw-animate plugin is installed). */}
      <DialogContent
        className={cn("overflow-hidden p-0 shadow-modal max-w-[640px]", commandDialogMotion)}
        aria-label={t("title")}
      >
        {/* `DialogTitle` is visually hidden but required by Radix for SR
            announcement. The visible heading is the input placeholder. */}
        <DialogTitle className="sr-only">{t("title")}</DialogTitle>
        {/*
          `shouldFilter={false}` — `cmdk` defaults to client-side
          fuzzy filtering on the `value` of each Item. Our results
          already come from the server pre-filtered + pre-ranked, so
          letting `cmdk` re-filter would (a) drop server hits whose
          title doesn't contain the literal query and (b) override
          the server's relevance ordering. The static "Go to …" and
          quick-create rows are always shown alongside, so the user
          can still trigger them with any query.
        */}
        <Command
          shouldFilter={false}
          className="[&_[cmdk-input]]:h-12"
          // The combobox role + listbox are applied by `cmdk` on the
          // input + list elements automatically. We override label
          // here so the SR announcement is meaningful.
          label={t("title")}
        >
          <CommandInput
            value={query}
            onValueChange={handleQueryChange}
            placeholder={t("placeholder")}
            autoFocus
            aria-label={t("placeholder")}
          />
          <CommandList>
            {/* Empty state branches:
                  - No query → static nav + quick-create groups
                  - With query, loading → "Searching…"
                  - With query, errored → "Couldn't search"
                  - With query, no hits → "No results" */}
            {hasQuery && loading ? (
              <div className="py-6 text-center text-sm text-on-surface-variant" aria-live="polite">
                {t("loading")}
              </div>
            ) : null}
            {hasQuery && errored ? (
              <div
                className="py-6 text-center text-sm text-error"
                aria-live="assertive"
                role="alert"
              >
                {t("error")}
              </div>
            ) : null}
            {hasQuery && !loading && !errored && !hasResults ? (
              <CommandEmpty>{t("noResults")}</CommandEmpty>
            ) : null}

            {hasQuery && hasResults ? (
              <>
                {groups.constituents.length > 0 ? (
                  <CommandGroup heading={t("groups.constituents")}>
                    {groups.constituents.map((hit) => (
                      <HitRow key={hit.id} hit={hit} onSelect={handleSelect} icon={UserIcon} />
                    ))}
                  </CommandGroup>
                ) : null}

                {groups.campaigns.length > 0 ? (
                  <CommandGroup heading={t("groups.campaigns")}>
                    {groups.campaigns.map((hit) => (
                      <HitRow key={hit.id} hit={hit} onSelect={handleSelect} icon={Megaphone} />
                    ))}
                  </CommandGroup>
                ) : null}

                {groups.donations.length > 0 ? (
                  <CommandGroup heading={t("groups.donations")}>
                    {groups.donations.map((hit) => (
                      <HitRow key={hit.id} hit={hit} onSelect={handleSelect} icon={Heart} />
                    ))}
                  </CommandGroup>
                ) : null}
              </>
            ) : null}

            {!hasQuery ? (
              /* ADR-035 rule D16 — the static groups stagger in once per
                 open (group-level mini-cascade: ≤3 direct children, well
                 inside the 600 ms half-scale budget). The class is
                 dropped after the first keystroke of this open, so
                 returning to the empty state mid-session is instant; the
                 live search results above are animation-free by design
                 (rule B12: filtering never replays entrances). */
              <div className={hasTyped ? undefined : "cascade"}>
                <CommandGroup heading={t("groups.navigation")}>
                  {navigationCommands.map((cmd) => (
                    <CommandItem
                      key={cmd.id}
                      value={cmd.id}
                      onSelect={() => handleSelect(cmd.href)}
                    >
                      <cmd.icon size={16} aria-hidden="true" />
                      <span>{cmd.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>

                {quickCreateCommands.length > 0 ? (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading={t("groups.quickCreate")}>
                      {quickCreateCommands.map((cmd) => (
                        <CommandItem
                          key={cmd.id}
                          value={cmd.id}
                          onSelect={() => handleSelect(cmd.href)}
                        >
                          <cmd.icon size={16} aria-hidden="true" />
                          <span>{cmd.label}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                ) : null}
              </div>
            ) : null}
          </CommandList>

          <div
            className="flex items-center justify-center gap-4 border-t border-outline-variant bg-surface-container-low px-4 py-2 text-xs text-on-surface-variant"
            aria-hidden="true"
          >
            <FooterHint label={t("footer.navigate")} keys={["↑", "↓"]} />
            <FooterHint label={t("footer.select")} keys={["⏎"]} />
            <FooterHint label={t("footer.close")} keys={["Esc"]} />
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

interface HitRowProps {
  hit: SearchHit;
  onSelect: (href: string) => void;
  icon: typeof UserIcon;
}

function HitRow({ hit, onSelect, icon: Icon }: HitRowProps) {
  // `cmdk` uses `value` as the key for keyboard navigation; pair it
  // with the type so two entities with the same display name don't
  // collide on selection (e.g. "Marie" the constituent vs. "Marie"
  // a quick-create suggestion).
  const value = `${hit.type}:${hit.id}`;
  return (
    <CommandItem value={value} onSelect={() => onSelect(hit.href)}>
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-surface-container-low">
        <Icon size={14} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-on-surface">{hit.title}</span>
        {hit.subtitle ? (
          <span className="truncate text-xs text-on-surface-variant">{hit.subtitle}</span>
        ) : null}
      </span>
    </CommandItem>
  );
}

interface FooterHintProps {
  label: string;
  keys: string[];
}

function FooterHint({ label, keys }: FooterHintProps) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="rounded-sm border border-outline-variant bg-surface-container px-1 py-px font-mono text-xs"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}
