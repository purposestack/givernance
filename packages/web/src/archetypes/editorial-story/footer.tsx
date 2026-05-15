import type { FooterSlotProps } from "../types";

export function EditorialFooter({ data }: FooterSlotProps) {
  return (
    <footer className="editorial-footer">
      {data.organisationName || "The Editorial"} · Powered by Givernance
    </footer>
  );
}
