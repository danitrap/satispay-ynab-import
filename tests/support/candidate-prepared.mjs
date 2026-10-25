/** A prepared import built from the candidate fields older service tests used. */
export const preparedFromCandidates = (candidates) => ({
  movements: candidates.map((candidate) => {
    const provisional = candidate.reviewReason !== undefined;
    return {
      _tag: provisional ? "ProvisionalTransaction" : "ImportCandidate",
      movement: {
        satispayMovementIdentifier: { _tag: "Unique", value: candidate.satispayId },
        date: { _tag: "Valid", calendarDate: candidate.date, instantMs: 0 },
        nominalAmount: { _tag: "Absent" },
        reportedWalletAmount: { _tag: "Absent" },
        mealVoucherAmount: { _tag: "Absent" },
        flexBenefitAmount: { _tag: "Absent" },
        walletBalance: { _tag: "Absent" },
        satispayApproval: "approved",
        kind: "other",
        typeLabel: candidate.type ?? "Altro",
        name: candidate.payee ?? "Shop",
        description: candidate.memo ?? "",
      },
      amountMilliunits: candidate.amountMilliunits,
      ...(provisional
        ? { provisionalWalletAmount: 0, reason: candidate.reviewReason }
        : { walletAmount: 0 }),
    };
  }),
  importCutoff: "2026-10-01",
  refundsAdjusted: 0,
  refundsUnresolved: 0,
  balanceCheck: { status: "unavailable", reason: "insufficient_balance_snapshots" },
  totals: { _tag: "Exact", inflowMilliunits: 0, outflowMilliunits: 0, netMilliunits: 0 },
});

export const emptyPreparedImport = preparedFromCandidates([]);
