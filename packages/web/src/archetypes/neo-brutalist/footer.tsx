import type { FooterSlotProps } from "../types";

export function NeoBrutalistFooter({ data }: FooterSlotProps) {
  return (
    <footer className="neo-footer">
      {data.organisationName || "ANON"} {"// POWERED BY GIVERNANCE"}
    </footer>
  );
}
