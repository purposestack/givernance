import { Logo } from "@/components/shared/logo";

export function AuthLogo() {
  return (
    <div className="mb-8 flex items-center justify-center gap-3">
      <Logo className="h-10 w-10 shrink-0" />
      <span className="font-heading text-3xl tracking-tight text-on-surface">Givernance</span>
    </div>
  );
}
