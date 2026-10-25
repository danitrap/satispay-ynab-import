import type { CalendarDate, Cents } from "../domain.ts";

/**
 * A Satispay movement read from a Satispay export.
 * Missing or duplicate identifiers, bad dates and unreadable amounts stay on the movement.
 */
export type SatispayMovement = {
  readonly satispayMovementIdentifier: SatispayMovementIdentifier;
  readonly date: SatispayMovementDate;
  readonly nominalAmount: MovementAmount;
  readonly reportedWalletAmount: MovementAmount;
  readonly mealVoucherAmount: MovementAmount;
  readonly flexBenefitAmount: MovementAmount;
  readonly walletBalance: MovementAmount;
  readonly satispayApproval: SatispayApproval;
  readonly kind: SatispayMovementKind;
  readonly typeLabel: string;
  readonly name: string;
  readonly description: string;
};

/** A numeric cell is not a usable identifier: a spreadsheet can rewrite it. */
export type SatispayMovementIdentifier =
  | { readonly _tag: "Unique"; readonly value: string }
  | { readonly _tag: "Duplicate"; readonly value: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "NotText" };

export type SatispayMovementDate =
  | { readonly _tag: "Valid"; readonly calendarDate: CalendarDate; readonly instantMs: number }
  | { readonly _tag: "Invalid" };

/** `Absent` is an empty cell. A parsed zero stays an amount. */
export type MovementAmount =
  | { readonly _tag: "Amount"; readonly cents: Cents }
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Unreadable" };

export type SatispayApproval = "approved" | "notApproved";

export type SatispayMovementKind = "merchantPurchase" | "merchantRefund" | "cashback" | "other";

/**
 * Movements from one Satispay export.
 * `includesWalletBalance` is false when that column is missing.
 */
export type SatispayExportRead = {
  readonly movements: readonly SatispayMovement[];
  readonly includesWalletBalance: boolean;
};
