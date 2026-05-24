// #440 — TopTenantsList
"use client";

import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

import { GradeChip } from "./grade-chip";
import styles from "./top-tenants-list.module.css";
import type { ColumnKey, TenantRow } from "./types";

export interface TopTenantsListLabels {
  /** Already-translated column heading for the name+share track column. */
  nameShare: string;
  /** Already-translated column heading for the score chip. */
  score: string;
  /** Already-translated column heading for the volume column. */
  volume: string;
  /** Already-translated commission prefix (e.g. "comm."). */
  commissionPrefix?: string;
  /** Already-translated row aria-label template suffix. */
  rowAriaSuffix?: string;
}

export interface TopTenantsListProps {
  rows: TenantRow[];
  /**
   * Columns to render, in order. Default
   * `["rank", "name", "grade", "amount"]` — the `share` column is
   * folded INTO the name column (track bar beneath the link).
   */
  columns?: ColumnKey[];
  labels: TopTenantsListLabels;
  className?: string;
}

const DEFAULT_COLUMNS: ColumnKey[] = ["rank", "name", "grade", "amount"];

export function TopTenantsList({
  rows,
  columns = DEFAULT_COLUMNS,
  labels,
  className,
}: TopTenantsListProps) {
  // Width animation on mount — the share fill bars grow from 0% to
  // their target. The target is exposed as a `--target-w` CSS custom
  // property (set inline per row), and the baseline 0% / target swap
  // happens by toggling the `.isGrown` modifier on the next two
  // animation frames. No inline `width: …%` writes — the modifier
  // class reads `var(--target-w)` from the colocated CSS module.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const fills = root.querySelectorAll<HTMLElement>("[data-target-width]");
    const grownClass = styles.isGrown;
    if (!grownClass) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const fill of fills) {
          fill.classList.add(grownClass);
        }
      }),
    );
  }, []);

  return (
    <div ref={listRef} className={cn(styles.list, className)}>
      <div className={cn(styles.row, styles.head)} aria-hidden="true">
        {columns.includes("rank") ? <span /> : null}
        {columns.includes("name") ? <span>{labels.nameShare}</span> : null}
        {columns.includes("grade") ? (
          <span className={styles.cellCenter}>{labels.score}</span>
        ) : null}
        {columns.includes("amount") ? (
          <span className={styles.cellRight}>{labels.volume}</span>
        ) : null}
      </div>
      {/* The list itself uses semantic ul/li — biome's a11y rule rightly
          rejects role="list" on a div. The visible header above is a
          presentation row (aria-hidden) since column headers don't map
          cleanly to a flat list semantic; SR users get the per-row
          accessible name (tenant link text) instead. */}
      <ul className={styles.ulReset}>
        {rows.map((row, index) => (
          <li key={row.id} className={styles.row}>
            {columns.includes("rank") ? <span className={styles.rank}>{index + 1}</span> : null}
            {columns.includes("name") ? (
              <div className={styles.nameCell}>
                <a href={row.href ?? "#"} className={styles.name}>
                  {row.name}
                </a>
                <div className={styles.meta}>
                  <span className={styles.track}>
                    <span
                      className={styles.fill}
                      data-target-width={row.sharePercent}
                      // Caller-derived numeric percent → CSS custom
                      // property (Exception 2). Baseline width 0% +
                      // `.isGrown` flip live in top-tenants-list.module.css.
                      style={{ "--target-w": `${row.sharePercent}%` } as React.CSSProperties}
                    />
                  </span>
                  <span className={styles.share}>
                    {row.sharePercent.toString().replace(".", ",")}%
                  </span>
                </div>
              </div>
            ) : null}
            {columns.includes("grade") ? (
              <span className={styles.cellCenter}>
                <GradeChip grade={row.grade} score={row.score} />
              </span>
            ) : null}
            {columns.includes("amount") ? (
              <span className={styles.amount}>
                {row.volume}
                {row.commission ? (
                  <small>
                    {labels.commissionPrefix ?? "comm."} {row.commission}
                  </small>
                ) : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
