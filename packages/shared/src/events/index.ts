/** Domain event type definitions for NATS JetStream */

interface BaseEvent {
  /** Unique event ID (UUID v7) */
  eventId: string
  /** ISO 8601 timestamp */
  timestamp: string
  /** Organization ID for multi-tenancy */
  orgId: string
  /** User who triggered the event */
  userId: string
}

export interface DonationCreated extends BaseEvent {
  type: 'donation.created'
  payload: {
    donationId: string
    constituentId: string
    amountCents: number
    currency: string
  }
}

export interface ConstituentUpdated extends BaseEvent {
  type: 'constituent.updated'
  payload: {
    constituentId: string
    changedFields: string[]
  }
}

export interface ConstituentMerged extends BaseEvent {
  type: 'constituent.merged'
  payload: {
    survivorId: string
    mergedIds: string[]
  }
}

export interface ReceiptGenerated extends BaseEvent {
  type: 'receipt.generated'
  payload: {
    donationId: string
    receiptNumber: string
    fiscalYear: number
  }
}

export interface GdprErasureRequested extends BaseEvent {
  type: 'gdpr.erasure_requested'
  payload: {
    constituentId: string
    requestedBy: string
  }
}

/** Union of all domain events */
export type DomainEvent =
  | DonationCreated
  | ConstituentUpdated
  | ConstituentMerged
  | ReceiptGenerated
  | GdprErasureRequested
