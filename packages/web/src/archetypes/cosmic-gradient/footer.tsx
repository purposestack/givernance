import type { FooterSlotProps } from "../types";

export function CosmicFooter({ data }: FooterSlotProps) {
  return (
    <footer className="cosmic-footer">
      <span>{data.organisationName || "Public donation"} · ▲ Powered by Givernance</span>
    </footer>
  );
}
