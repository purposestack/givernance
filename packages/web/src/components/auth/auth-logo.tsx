/**
 * Auth logo matching .auth-logo from base.css:
 * Centered flex with logo mark + "Givernance" text, mb-8.
 * The logo mark is a 64×64 rounded square with primary-50 background.
 */
export function AuthLogo() {
  return (
    <div className="mb-8 flex items-center justify-center gap-3">
      <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-xl bg-primary-50 p-2">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-xl font-bold text-on-primary">
          G
        </div>
      </div>
      <span className="font-heading text-2xl text-text">Givernance</span>
    </div>
  );
}
