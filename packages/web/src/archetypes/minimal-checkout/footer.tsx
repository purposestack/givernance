import type { FooterSlotProps } from "../types";

export function MinimalFooter({ data }: FooterSlotProps) {
  return (
    <footer className="minimal-footer">
      Secured by Stripe · {data.organisationName || "Givernance"}
    </footer>
  );
}
