import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface Breadcrumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  actions?: ReactNode;
  className?: string;
}

function BreadcrumbLabel({ crumb, isLast }: { crumb: Breadcrumb; isLast: boolean }) {
  if (crumb.href && !isLast) {
    return (
      <Link href={crumb.href} className="whitespace-nowrap hover:text-on-surface">
        {crumb.label}
      </Link>
    );
  }
  return (
    <span
      className={cn("truncate", isLast ? "font-medium text-on-surface" : "whitespace-nowrap")}
      aria-current={isLast ? "page" : undefined}
    >
      {crumb.label}
    </span>
  );
}

function Breadcrumbs({ items }: { items: Breadcrumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex items-center gap-2 text-sm text-on-surface-variant">
        {items.map((crumb, index) => {
          const isLast = index === items.length - 1;
          const key = crumb.href ?? `${crumb.label}-${isLast ? "current" : "parent"}`;
          return (
            <Fragment key={key}>
              <li className="min-w-0">
                <BreadcrumbLabel crumb={crumb} isLast={isLast} />
              </li>
              {!isLast ? (
                <li aria-hidden="true" className="text-xs text-outline-variant">
                  /
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("mb-8 flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
        <h1 className="font-heading text-5xl font-normal leading-[1.1] tracking-tight text-on-surface">
          {title}
        </h1>
        {description ? <p className="mt-2 text-lg text-on-surface-variant">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
    </header>
  );
}
