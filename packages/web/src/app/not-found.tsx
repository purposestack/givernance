import { FileQuestion } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <FileQuestion className="mx-auto h-12 w-12 text-text-muted" />
        <h1 className="mt-6 font-heading text-section-title text-text">Page not found</h1>
        <p className="mt-2 text-md text-text-secondary">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex h-[var(--btn-height-md)] items-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary shadow-button transition-colors hover:bg-primary-hover focus-visible:shadow-ring"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
