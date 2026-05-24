import { mockToast } from "@/tests/mocks";
import { useToast } from "../toast";

describe("useToast", () => {
  it("returns the sonner imperative API surface (success/error/info/warning)", () => {
    const api = useToast();
    api.success("Campagne email programmée — invitation PMF envoyée à 38 tenants.");
    api.error("Le rappel n'a pas pu être planifié.");
    expect(mockToast.success).toHaveBeenCalledWith(
      "Campagne email programmée — invitation PMF envoyée à 38 tenants.",
    );
    expect(mockToast.error).toHaveBeenCalledWith("Le rappel n'a pas pu être planifié.");
    expect(typeof api.warning).toBe("function");
    // `info` falls back to a no-op when the underlying mock omits it
    // — kept callable so consumer code doesn't need null-checks.
    expect(typeof api.info).toBe("function");
  });
});
