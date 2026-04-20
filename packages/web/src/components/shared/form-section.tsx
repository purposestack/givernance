import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface FormSectionProps extends HTMLAttributes<HTMLElement> {
  title: string;
  description?: ReactNode;
}

export function FormSection({
  title,
  description,
  className,
  children,
  ...props
}: FormSectionProps) {
  return (
    <section
      className={cn(
        "grid gap-6 border-b border-outline-variant py-8 last:border-b-0",
        "md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]",
        className,
      )}
      {...props}
    >
      <header className="space-y-1">
        <h2 className="font-heading text-xl leading-tight text-on-surface">{title}</h2>
        {description ? <p className="text-sm text-on-surface-variant">{description}</p> : null}
      </header>
      <div className="space-y-5">{children}</div>
    </section>
  );
}
