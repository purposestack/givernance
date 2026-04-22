/**
 * Auth logo matching .auth-logo from base.css:
 * Centered flex with logo mark + "Givernance" text, mb-8.
 * The logo mark is a 64×64 rounded square with primary-50 background.
 */
export function AuthLogo() {
  return (
    <div className="mb-8 flex items-center justify-center gap-3">
      <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl bg-primary-50 p-2">
        <img src="/logo-pheonix-vert.svg" alt="Givernance" className="h-11 w-11 object-contain" />
      </div>
      <span className="font-heading text-2xl text-text">Givernance</span>
    </div>
  );
}
