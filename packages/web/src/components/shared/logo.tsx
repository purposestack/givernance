// Givernance brand mark — three interlocking isometric cubes (teal + coral).
// 2026 rebrand (website PR #24). The fill colours are fixed brand values, not
// design tokens: teal #008570 + coral #ec6a66. Canonical copy also lives at
// docs/design/shared/assets/givernance-logo.svg (favicon / mockups) — keep the
// two in sync.
const TEAL = "#008570";
const CORAL = "#ec6a66";

// Shared cube geometry — one body path (teal) + one cap path (coral), placed
// three times via the transforms below to form the interlocking trio.
const CUBE_BODY =
  "M440,162.652L440,349.573C440,356.022 436.55,361.979 430.955,365.187L362.648,404.364C357.101,407.545 350.284,407.545 344.737,404.364L276.429,365.187C270.835,361.979 267.385,356.022 267.385,349.573L267.385,271.461C267.385,264.993 270.854,259.023 276.474,255.821L372.692,201L372.692,200.782L440,162.652Z";
const CUBE_CAP =
  "M372.692,200.782L372.692,101L422.049,129.598C433.16,136.036 440,147.906 440,160.747L440,162.652L372.692,200.782Z";

const CUBE_TRANSFORMS = [
  "matrix(1.000819,0,0,1.000819,0.018136,-0.082685)",
  "matrix(-0.495948,-0.859007,0.859007,-0.495948,158.15141,586.415061)",
  "matrix(-0.500409,0.866734,-0.866734,-0.500409,592.049884,158.497743)",
];

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 500 500"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {CUBE_TRANSFORMS.map((transform) => (
        <g key={transform} transform={transform}>
          <path d={CUBE_BODY} fill={TEAL} />
          <path d={CUBE_CAP} fill={CORAL} />
        </g>
      ))}
    </svg>
  );
}
