import Link, { type LinkProps } from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Size = "md" | "lg";

const sizeClass: Record<Size, string> = {
  md: "h-[var(--btn-height-md)]",
  lg: "h-[var(--btn-height-lg)]",
};

const baseClass =
  "inline-flex items-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary shadow-button transition-[background-color] hover:bg-primary-hover focus-visible:shadow-ring";

/**
 * Primary action button (renders a <button>).
 */
export function PrimaryButton({
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { size?: Size }) {
  const cls = `${sizeClass[size]} ${baseClass}${className ? ` ${className}` : ""}`;
  return <button {...props} className={cls} />;
}

/**
 * Primary action link (renders a Next.js <Link>).
 */
export function PrimaryLink({
  size = "md",
  className,
  children,
  ...props
}: LinkProps & { size?: Size; className?: string; children?: ReactNode }) {
  const cls = `${sizeClass[size]} ${baseClass}${className ? ` ${className}` : ""}`;
  return (
    <Link {...props} className={cls}>
      {children}
    </Link>
  );
}
