/** Transformer — map Salesforce Contact fields to Givernance constituent */

import type { ConstituentCreate } from "@givernance/shared/validators";

/** Salesforce Contact CSV row shape */
interface SalesforceContact {
  Id: string;
  FirstName: string;
  LastName: string;
  Email: string;
  Phone: string;
  npe01__Type__c?: string;
}

/**
 * Map a Salesforce constituent type to a Givernance type. Salesforce carries
 * a single value per Contact, so the result is always a one-element array
 * (issue #465). A multi-value Salesforce source would split here.
 */
type ConstituentTypeValue = NonNullable<ConstituentCreate["types"]>[number];

function mapTypes(sfType?: string): ConstituentTypeValue[] {
  const mapping: Record<string, ConstituentTypeValue> = {
    Donor: "donor",
    Volunteer: "volunteer",
    Member: "member",
    Beneficiary: "beneficiary",
    Partner: "partner",
  };
  return [sfType ? (mapping[sfType] ?? "donor") : "donor"];
}

/** Transform a Salesforce Contact row into a Givernance constituent */
export function transformContact(row: SalesforceContact): ConstituentCreate {
  return {
    firstName: row.FirstName,
    lastName: row.LastName,
    email: row.Email || undefined,
    phone: row.Phone || undefined,
    types: mapTypes(row.npe01__Type__c),
  };
}

/** Transform a batch of Salesforce Contact rows */
export function transformContacts(rows: SalesforceContact[]): ConstituentCreate[] {
  return rows.map(transformContact);
}
