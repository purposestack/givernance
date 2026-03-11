/** Transformer — map Salesforce Contact fields to Givernance constituent */

import type { ConstituentCreate } from '@givernance/shared/validators'

/** Salesforce Contact CSV row shape */
interface SalesforceContact {
  Id: string
  FirstName: string
  LastName: string
  Email: string
  Phone: string
  npe01__Type__c?: string
}

/** Map Salesforce constituent type to Givernance type */
function mapType(sfType?: string): ConstituentCreate['type'] {
  const mapping: Record<string, ConstituentCreate['type']> = {
    Donor: 'donor',
    Volunteer: 'volunteer',
    Member: 'member',
    Beneficiary: 'beneficiary',
    Partner: 'partner',
  }
  return sfType ? (mapping[sfType] ?? 'donor') : 'donor'
}

/** Transform a Salesforce Contact row into a Givernance constituent */
export function transformContact(row: SalesforceContact): ConstituentCreate {
  return {
    firstName: row.FirstName,
    lastName: row.LastName,
    email: row.Email || undefined,
    phone: row.Phone || undefined,
    type: mapType(row.npe01__Type__c),
  }
}

/** Transform a batch of Salesforce Contact rows */
export function transformContacts(rows: SalesforceContact[]): ConstituentCreate[] {
  return rows.map(transformContact)
}
