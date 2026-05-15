import type { FooterSlotProps } from "../types";

export function CivicFooter({ data }: FooterSlotProps) {
  return (
    <footer className="civic-footer">
      {data.organisationName || "Public institution"} · Powered by Givernance
    </footer>
  );
}
