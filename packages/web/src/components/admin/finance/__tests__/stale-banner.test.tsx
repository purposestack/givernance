import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { StaleBanner } from "../stale-banner";

describe("StaleBanner", () => {
  const baseProps = {
    band: "stale" as const,
    title: "Données d'enquête périmées",
    description: "La dernière enquête PMF a été clôturée le 18 janvier 2026.",
  };

  it("uses role='status' (NOT alert) on initial render", () => {
    render(<StaleBanner {...baseProps} actions={[]} />);
    const banner = screen.getByRole("status");
    // No `aria-live` — role="status" already implies polite, and the
    // banner is rendered as page chrome on landing (not a runtime
    // interruption). Doubling the announcement is the NIT we removed.
    expect(banner).not.toHaveAttribute("aria-live");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.getAttribute("role")).not.toBe("alert");
  });

  it("renders each action with its verbose aria-label and fires onClick", async () => {
    const user = userEvent.setup();
    const onPrimary = vi.fn();
    const onGhost = vi.fn();
    render(
      <StaleBanner
        {...baseProps}
        actions={[
          {
            label: "Lancer une campagne email",
            icon: "mail",
            variant: "primary",
            ariaLabel: "Lancer une campagne email vers les 38 tenants éligibles à l'enquête PMF",
            onClick: onPrimary,
          },
          {
            label: "Activer le survey in-app",
            icon: "smart_button",
            variant: "ghost",
            ariaLabel: "Activer le survey in-app au prochain login",
            onClick: onGhost,
          },
        ]}
      />,
    );
    const primary = screen.getByRole("button", {
      name: "Lancer une campagne email vers les 38 tenants éligibles à l'enquête PMF",
    });
    expect(primary).toHaveClass("btn-stale--primary");
    await user.click(primary);
    expect(onPrimary).toHaveBeenCalledOnce();

    const ghost = screen.getByRole("button", {
      name: "Activer le survey in-app au prochain login",
    });
    expect(ghost).toHaveClass("btn-stale--ghost");
    await user.click(ghost);
    expect(onGhost).toHaveBeenCalledOnce();
  });

  it("disabled actions become inert (UX-review pending item)", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <StaleBanner
        {...baseProps}
        actions={[
          {
            label: "Déjà lancé",
            variant: "primary",
            ariaLabel: "Campagne déjà lancée",
            onClick,
            disabled: true,
          },
        ]}
      />,
    );
    const btn = screen.getByRole("button", { name: "Campagne déjà lancée" });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
