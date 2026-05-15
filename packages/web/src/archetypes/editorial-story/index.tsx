/**
 * Editorial Story archetype (Epic #362) — long-form photo essay.
 *
 * Visual reference: `docs/design/donations/public-editorial-story.html`.
 * For orgs that lead with narrative (heritage, cultural, conservation).
 * No easter egg — editorial voice keeps things contemplative.
 */

import type { ArchetypeModule } from "../types";
import { EditorialAmountPicker } from "./amount-picker";
import { EditorialFooter } from "./footer";
import { EditorialHero } from "./hero";
import { EditorialProgress } from "./progress";

import "./tokens.css";

const editorialStory: ArchetypeModule = {
  key: "editorial-story",
  Hero: EditorialHero,
  Progress: EditorialProgress,
  AmountPicker: EditorialAmountPicker,
  Footer: EditorialFooter,
};

export default editorialStory;
