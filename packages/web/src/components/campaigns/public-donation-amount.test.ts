import { parseDonationAmount } from "./public-donation-amount";

describe("parseDonationAmount", () => {
  it.each([
    ["12,50", 1250],
    ["12.5", 1250],
    [" 25 ", 2500],
    ["1", 100],
    ["10000", 1_000_000],
    ["10000,00", 1_000_000],
    // Float trap: Number("12.35") * 100 === 1234.9999999999998.
    ["12.35", 1235],
  ])("parses %j to %i cents", (input, cents) => {
    expect(parseDonationAmount(input)).toEqual({ ok: true, cents });
  });

  it.each([
    ["", "required"],
    ["   ", "required"],
    ["abc", "invalid"],
    ["-1", "invalid"],
    ["1e3", "invalid"],
    ["1 000", "invalid"],
    ["12.345", "invalid"],
    ["12.", "invalid"],
    [",50", "invalid"],
    ["0", "belowMin"],
    ["0,99", "belowMin"],
    ["10000.01", "aboveMax"],
    ["99999999999999999999999999", "aboveMax"],
  ])("rejects %j as %s", (input, error) => {
    expect(parseDonationAmount(input)).toEqual({ ok: false, error });
  });
});
