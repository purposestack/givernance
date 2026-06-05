/**
 * Auth-page background — a faithful port of the marketing site's hero
 * "filigree waves" backdrop (givernance-website, src/components/home/hero.tsx
 * `WaveBackdrop`). It sits the login / signup / password screens in the visual
 * continuation of the marketing hero: the same cream page background (set on
 * the (auth) layout), the same drifting teal→ember wave lines, and the same
 * soft ember glow in the top-right corner.
 *
 * Pure SVG + CSS animation (the `wave-drift` keyframe + `.auth-wave-line`
 * utility live in globals.css) — no canvas, no JS, no pointer interaction.
 * This replaces the previous interactive canvas icon-rain background; it is
 * lighter, server-rendered, and matches the marketing site exactly. The
 * global `prefers-reduced-motion` rule in globals.css freezes the drift.
 *
 * `aria-hidden` + `pointer-events-none` keep it out of the a11y tree and
 * never let it intercept clicks on the auth card layered above it.
 */
// 14 stacked wave lines, staggered in vertical offset, opacity, drift delay
// and duration — the exact recipe from the marketing hero (hero.tsx). Keyed
// by their unique vertical offset rather than the array index.
const WAVE_LINES = Array.from({ length: 14 }, (_, i) => ({
  translateY: (i - 6.5) * 42,
  opacity: 0.55 + (i % 3) * 0.15,
  delaySeconds: i * -2,
  durationSeconds: 28 + (i % 3) * 4,
}));

export function AuthWaves() {
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-cream"
      aria-hidden="true"
    >
      <svg
        className="auth-waves absolute inset-y-0 right-0 h-full w-[60%]"
        viewBox="0 0 800 900"
        preserveAspectRatio="xMaxYMid slice"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="authWaveFade" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="var(--color-wave-deep)" stopOpacity="0" />
            <stop offset="70%" stopColor="var(--color-wave-deep)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-ember)" stopOpacity="0.35" />
          </linearGradient>
          <path
            id="auth-wave-path"
            d="M-200,450 C-50,380 50,520 200,450 C350,380 450,520 600,450 C750,380 850,520 1000,450 C1150,380 1250,520 1400,450"
          />
        </defs>
        <g fill="none" stroke="url(#authWaveFade)" strokeWidth="0.9" strokeLinecap="round">
          {WAVE_LINES.map((line) => (
            <g key={line.translateY} transform={`translate(0 ${line.translateY})`}>
              <use
                href="#auth-wave-path"
                className="auth-wave-line"
                style={{
                  opacity: line.opacity,
                  animationDelay: `${line.delaySeconds}s`,
                  animationDuration: `${line.durationSeconds}s`,
                }}
              />
            </g>
          ))}
        </g>
      </svg>

      {/* Soft ember glow, top-right — mirrors the marketing hero's blurred
          ember blob (hero.tsx). */}
      <div className="absolute top-[10%] right-[-15%] h-[600px] w-[600px] rounded-full bg-ember opacity-15 blur-[140px]" />
    </div>
  );
}
