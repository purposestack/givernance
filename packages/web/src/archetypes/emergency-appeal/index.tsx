/**
 * Emergency Appeal archetype (Epic #362) — urgent, counter-led,
 * one-time-first.
 *
 * Visual reference: `docs/design/donations/public-emergency-appeal.html`.
 * For disasters, medical campaigns, deadline-driven asks. No easter
 * egg — the context precludes delight moments.
 */

import type { ArchetypeModule } from "../types";
import { EmergencyAmountPicker } from "./amount-picker";
import { EmergencyFooter } from "./footer";
import { EmergencyHero } from "./hero";
import { EmergencyProgress } from "./progress";

import "./tokens.css";

const emergencyAppeal: ArchetypeModule = {
  key: "emergency-appeal",
  Hero: EmergencyHero,
  Progress: EmergencyProgress,
  AmountPicker: EmergencyAmountPicker,
  Footer: EmergencyFooter,
};

export default emergencyAppeal;
