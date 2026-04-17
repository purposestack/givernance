/**
 * Auth card wrapper matching .auth-card from base.css:
 * max-width 440px, white background, rounded-2xl, elevated shadow, generous padding.
 */
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-[440px] rounded-2xl bg-surface-container-lowest p-10 shadow-elevated">
      {children}
    </div>
  );
}
