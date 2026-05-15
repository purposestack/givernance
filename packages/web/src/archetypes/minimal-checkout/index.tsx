/**
 * Minimal Checkout archetype (Epic #362) — Stripe-Payment-Link grade.
 *
 * Visual reference: `docs/design/donations/public-minimal-checkout.html`.
 * For orgs whose donors already trust them — recurring top-ups,
 * alumni from a known list. No pitch, no animation, no easter egg.
 */

import type { ArchetypeModule } from "../types";
import { MinimalAmountPicker } from "./amount-picker";
import { MinimalFooter } from "./footer";
import { MinimalHero } from "./hero";
import { MinimalProgress } from "./progress";

import "./tokens.css";

const minimalCheckout: ArchetypeModule = {
  key: "minimal-checkout",
  Hero: MinimalHero,
  Progress: MinimalProgress,
  AmountPicker: MinimalAmountPicker,
  Footer: MinimalFooter,
};

export default minimalCheckout;
