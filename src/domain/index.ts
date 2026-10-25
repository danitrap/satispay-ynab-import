/**
 * Domain layer for pure movement rules.
 * Movement classification, refund matching and the wallet balance check live here.
 * Prepared import still uses the legacy row ledger until it adopts this classification.
 * This layer imports nothing from the application, infrastructure or HTTP layers, and nothing from Effect.
 */
export type {
  MovementAmount,
  SatispayApproval,
  SatispayExportRead,
  SatispayMovement,
  SatispayMovementDate,
  SatispayMovementIdentifier,
  SatispayMovementKind,
} from "./satispay-movement.ts";
export { classifyMovements } from "./movement-classification.ts";
export type {
  AmbiguityReason,
  ClassifiedMovement,
  ImportCandidate,
  MovementClassification,
  ProvisionalTransaction,
  RejectedMovement,
  RejectionReason,
  SkipReason,
  SkippedMovement,
  WalletBalanceCheck,
  WalletTotals,
} from "./movement-classification.ts";
