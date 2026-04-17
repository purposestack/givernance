"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guards";
import {
  type CountryCode,
  LEGAL_TYPES,
  type LegalType,
  ONBOARDING_COUNTRIES,
  ONBOARDING_CURRENCIES,
  type OnboardingCurrency,
  type OnboardingStep1Input,
  type Tenant,
} from "@/models/tenant";
import { completeOnboarding, saveOnboardingStep1 } from "@/services/tenant-service";

export interface ActionResult<T = undefined> {
  ok: boolean;
  /** Field-level error keys for the client to translate (e.g. "name.required"). */
  fieldErrors?: Record<string, string>;
  /** Generic i18n key describing a non-field failure. */
  errorKey?: string;
  data?: T;
}

function isCountry(value: unknown): value is CountryCode {
  return typeof value === "string" && (ONBOARDING_COUNTRIES as readonly string[]).includes(value);
}

function isLegalType(value: unknown): value is LegalType {
  return typeof value === "string" && (LEGAL_TYPES as readonly string[]).includes(value);
}

function isCurrency(value: unknown): value is OnboardingCurrency {
  return typeof value === "string" && (ONBOARDING_CURRENCIES as readonly string[]).includes(value);
}

/** Save Step 1 of the onboarding wizard. Triggered by the form action in `<StepOrganisation>`. */
export async function saveOrganisationAction(
  _prev: ActionResult<Tenant> | undefined,
  formData: FormData,
): Promise<ActionResult<Tenant>> {
  await requireAuth();

  const raw = {
    name: (formData.get("name") as string | null)?.trim() ?? "",
    country: formData.get("country"),
    legalType: formData.get("legalType"),
    currency: formData.get("currency"),
    registrationNumber: (formData.get("registrationNumber") as string | null)?.trim() ?? "",
  };

  const fieldErrors: Record<string, string> = {};
  if (raw.name.length === 0) fieldErrors.name = "required";
  else if (raw.name.length > 255) fieldErrors.name = "tooLong";
  if (!isCountry(raw.country)) fieldErrors.country = "required";
  if (!isLegalType(raw.legalType)) fieldErrors.legalType = "required";
  if (!isCurrency(raw.currency)) fieldErrors.currency = "required";
  if (raw.registrationNumber.length > 100) fieldErrors.registrationNumber = "tooLong";

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  const input: OnboardingStep1Input = {
    name: raw.name,
    country: raw.country as CountryCode,
    legalType: raw.legalType as LegalType,
    currency: raw.currency as OnboardingCurrency,
    ...(raw.registrationNumber ? { registrationNumber: raw.registrationNumber } : {}),
  };

  try {
    const saved = await saveOnboardingStep1(input);
    revalidatePath("/onboarding");
    return { ok: true, data: saved };
  } catch (err) {
    console.warn(
      "[onboarding] saveOnboardingStep1 failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, errorKey: "saveFailed" };
  }
}

/** Finalise onboarding and redirect to the dashboard. Triggered by the Step 5 CTA. */
export async function completeOnboardingAction(): Promise<void> {
  await requireAuth();

  try {
    await completeOnboarding();
  } catch (err) {
    console.warn(
      "[onboarding] completeOnboarding failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Surface the failure on the next /onboarding render rather than throwing
    // so the user isn't stuck in the wizard with a cryptic error.
    redirect("/onboarding?error=complete_failed");
  }

  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
