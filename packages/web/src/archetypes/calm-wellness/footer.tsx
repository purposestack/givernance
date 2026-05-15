import type { FooterSlotProps } from "../types";

export function CalmFooter({ data }: FooterSlotProps) {
  return (
    <footer className="calm-footer">
      {data.organisationName || "respire"} · ✦ powered by givernance
    </footer>
  );
}
