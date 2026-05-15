import type { FooterSlotProps } from "../types";

export function ActivistFooter({ data }: FooterSlotProps) {
  return (
    <footer className="activist-footer">
      <span>{data.organisationName || "Mobilise"}</span>
      <span>★ Powered by Givernance</span>
    </footer>
  );
}
