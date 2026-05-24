import { render, screen } from "@testing-library/react";

import { CurrencyDonut } from "../currency-donut";

describe("CurrencyDonut", () => {
  it("renders the role=img donut and the legend rows", () => {
    render(
      <CurrencyDonut
        ariaLabel="EUR 68%, GBP 19%, CHF 13%"
        centerLabel={{ count: 3, label: "devises" }}
        slices={[
          {
            key: "EUR",
            percent: 68,
            tone: "primary",
            label: "EUR",
            amount: "€873 480",
          },
          {
            key: "GBP",
            percent: 19,
            tone: "tertiary",
            label: "GBP",
            amount: "£212 088",
          },
          {
            key: "CHF",
            percent: 13,
            tone: "indigo",
            label: "CHF",
            amount: "CHF 152 350",
          },
        ]}
      />,
    );
    expect(screen.getByLabelText("EUR 68%, GBP 19%, CHF 13%")).toBeInTheDocument();
    // "EUR" appears twice — in the donut centre numeral row is "3" not
    // a code, so legend "EUR" is unique BUT "devises" + numeric "3"
    // exists. We assert the legend amount + percent instead.
    expect(screen.getByText("£212 088")).toBeInTheDocument();
    // Whole percent values render without a decimal; the mockup's
    // "13,0%" is a localized formatting choice the consumer pre-applies.
    expect(screen.getByText("13%")).toBeInTheDocument();
    // Legend currency codes — three of them.
    expect(screen.getAllByText(/EUR|GBP|CHF/).length).toBeGreaterThanOrEqual(3);
  });
});
