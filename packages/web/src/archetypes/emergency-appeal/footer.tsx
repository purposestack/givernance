import type { FooterSlotProps } from "../types";

export function EmergencyFooter({ data }: FooterSlotProps) {
  return (
    <footer className="emergency-footer">
      {data.organisationName || "Public appeal"} · Powered by Givernance
    </footer>
  );
}
