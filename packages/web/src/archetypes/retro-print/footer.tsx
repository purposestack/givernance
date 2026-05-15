import type { FooterSlotProps } from "../types";

export function RetroFooter({ data }: FooterSlotProps) {
  return (
    <footer className="retro-footer">
      {data.organisationName || "The Quarterly"} · Powered by Givernance
    </footer>
  );
}
