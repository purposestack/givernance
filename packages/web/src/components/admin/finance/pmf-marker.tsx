// #440 — PMFMarker
import styles from "./pmf-marker.module.css";

export interface PMFMarkerProps {
  /** PMF fit threshold position, 0-100. Default Sean Ellis threshold is 40. */
  thresholdPercent: number;
  /** Already-translated tag text (e.g. "seuil · 40%"). */
  label: string;
}

export function PMFMarker({ thresholdPercent, label }: PMFMarkerProps) {
  // Inline-style exception (Exception 2 per #440 spec): `left:X%` is a
  // dynamic positioning value driven by a runtime numeric prop. A
  // className-based system would require ~100 pre-baked utility classes
  // (`.left-1`, `.left-2`, …) which CSS doesn't ship by default and
  // which would still need an interpolation point. CSS custom property
  // approach would work but adds indirection for a single value.
  const leftStyle = { left: `${thresholdPercent}%` };
  return (
    <div className={styles.pmfMarker} aria-hidden="true">
      <span className={styles.line} style={leftStyle} />
      <span className={styles.tag} style={leftStyle}>
        {label}
      </span>
    </div>
  );
}
