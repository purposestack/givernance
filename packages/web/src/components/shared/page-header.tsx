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
    <header
      className={cn(
        "flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-start lg:justify-between",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
        <h1 className="font-heading text-4xl font-normal leading-[1.1] tracking-tight text-on-surface sm:text-5xl">
          {title}
        </h1>
        {description ? <p className="mt-2 text-lg text-on-surface-variant">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto sm:shrink-0 sm:items-center">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
