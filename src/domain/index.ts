/**
 * Domain layer for pure movement rules.
 * Money primitives, movement classification, refund matching, the wallet balance check and prepared import live here.
 * This layer imports nothing from the application, infrastructure or HTTP layers.
 * Branded primitives mention Effect's Brand as a type only; the module does not run Effect.
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
