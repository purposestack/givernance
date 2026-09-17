import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

import enMessages from "@/messages/en.json";
import frMessages from "@/messages/fr.json";
import { ActivistFooter } from "./activist/footer";
import { ActivistProgress } from "./activist/progress";
import { CosmicProgress } from "./cosmic-gradient/progress";
import { EmergencyProgress } from "./emergency-appeal/progress";
import { NeoBrutalistProgress } from "./neo-brutalist/progress";
import type { ArchetypePageData } from "./types";

// Issue #615 — the slots used to hardcode locale "en" and English labels.
// The shared test setup mocks next-intl with a fixed "en" locale and no ICU
// support, which can't see that bug; this file runs the REAL next-intl
// against the real catalogues.
vi.unmock("next-intl");

const DATA: ArchetypePageData = {
  campaignId: "11111111-1111-4111-8111-111111111111",
  title: "Appel de printemps",
  description: null,
  colorPrimary: "#08675b",
  goalAmountCents: 10_000_000,
  raisedCents: 5_546_496,
  donorCount: 1234,
  defaultCurrency: "CHF",
  organisationName: "Secours Alpin",
  organisationMission: null,
  organisationLogoUrl: null,
  publicPageStyle: "activist",
};

function renderIn(locale: "en" | "fr", node: ReactNode) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? frMessages : enMessages}
      timeZone="UTC"
    >
      {node}
    </NextIntlClientProvider>,
  );
}

/** `Intl` separates groups with NBSP / NNBSP in French — normalise for matching. */
function text(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/[  ]/g, " ");
}

describe("archetype slots follow the page locale and the campaign currency", () => {
  it("renders French labels, French number formatting and the campaign currency", () => {
    const { container } = renderIn("fr", <ActivistProgress data={DATA} />);

    const content = text(container);
    expect(content).toContain("Collecté");
    expect(content).toContain("Objectif");
    expect(content).toContain("55 464,96 CHF");
    expect(content).toContain("1 234");
    expect(content).not.toContain("RAISED");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      expect.stringContaining("pour cent financés"),
    );
  });

  it("keeps the English rendering in English", () => {
    const { container } = renderIn("en", <ActivistProgress data={DATA} />);

    const content = text(container);
    // The voice (uppercase) is CSS — the string itself is sentence case.
    expect(content).toContain("Raised");
    expect(content).toContain("CHF 55,464.96");
  });

  it("pluralises the donor count through ICU instead of a hardcoded English noun", () => {
    const { container: many } = renderIn("fr", <NeoBrutalistProgress data={DATA} />);
    expect(text(many)).toContain("1 234 contributeurs");

    const { container: one } = renderIn(
      "fr",
      <NeoBrutalistProgress data={{ ...DATA, donorCount: 1 }} />,
    );
    expect(text(one)).toContain("1 contributeur");
    expect(text(one)).not.toContain("contributeurs");
    expect(text(one)).not.toContain("backers");
  });

  it("renders rich-text emphasis from the translated sentence", () => {
    const { container } = renderIn("fr", <CosmicProgress data={DATA} />);

    const strong = [...container.querySelectorAll("strong")].map((node) => text(node));
    expect(strong).toEqual(["100 000,00 CHF", "55 %"]);
  });

  it("paints the currency symbol wherever the locale puts it", () => {
    const { container: fr } = renderIn("fr", <EmergencyProgress data={DATA} />);
    const frAmount = fr.querySelector(".emergency-progress__amount") as HTMLElement;
    expect(frAmount.querySelector(".currency")?.textContent).toBe("CHF");
    // Symbol trails in French — the old leading-non-digit regex lost it.
    expect(text(frAmount)).toBe("55 464,96 CHF");

    const { container: en } = renderIn("en", <EmergencyProgress data={DATA} />);
    const enAmount = en.querySelector(".emergency-progress__amount") as HTMLElement;
    expect(text(enAmount)).toBe("CHF 55,464.96");
  });

  it("translates the footer attribution", () => {
    const { container } = renderIn("fr", <ActivistFooter data={DATA} />);

    expect(text(container)).toContain("Propulsé par Givernance");
  });
});
