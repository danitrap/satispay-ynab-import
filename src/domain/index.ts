/**
 * Domain layer for pure movement rules.
 * Movement classification, refund matching, the wallet balance check and prepared import live here.
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
export { prepareImport } from "./prepared-import.ts";
export type { PreparedImport } from "./prepared-import.ts";
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
