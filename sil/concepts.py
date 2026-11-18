"""Insurance concepts and the XBRL tags that can carry them, in priority order.

Companies tag the same line item differently, and a few tags mean different things at different
companies, so each fallback must also pass a plausibility check against net premiums earned (see
sil/standardize.py). The tag list is loaded into ref.concept_tag, which also limits the core layer.
"""

from __future__ import annotations

# concept -> (kind, [tags in priority order], description)
CONCEPTS: dict[str, tuple[str, list[str], str]] = {
    "npe": ("duration", ["PremiumsEarnedNet", "PremiumsEarnedNetPropertyAndCasualty"],
            "Net premiums earned"),
    "npw": ("duration", ["PremiumsWrittenNet"], "Net premiums written"),
    "gpw": ("duration", ["PremiumsWrittenGross"], "Gross premiums written"),
    "losses": ("duration", [
        "PolicyholderBenefitsAndClaimsIncurredNet",
        "IncurredClaimsPropertyCasualtyAndLiability",
        "LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseIncurredClaims1",
        "LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseIncurredClaims",
    ], "Losses and loss adjustment expenses incurred, net of reinsurance"),
    "cy_losses": ("duration", [
        "SupplementalInformationForPropertyCasualtyInsuranceUnderwritersCurrentYearClaimsAndClaimsAdjustmentExpense",
        "LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseIncurredClaimsCurrentYear",
    ], "Losses incurred for the current accident year"),
    "py_development": ("duration", [
        "SupplementalInformationForPropertyCasualtyInsuranceUnderwritersPriorYearClaimsAndClaimsAdjustmentExpense",
        "LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseIncurredClaimsPriorYears",
    ], "Losses incurred for prior accident years (negative = favorable reserve development)"),
    "acq_cost": ("duration", [
        "DeferredPolicyAcquisitionCostAmortizationExpense",
        "AmortizationOfDeferredPolicyAcquisitionCosts",
    ], "Amortization of deferred policy acquisition costs"),
    "other_uw_exp": ("duration", [
        "OtherUnderwritingExpense",
        "GeneralAndAdministrativeExpense",
        "OperatingExpenses",
        "SellingGeneralAndAdministrativeExpense",
        "OtherCostAndExpenseOperating",
    ], "Other underwriting and operating expenses (tag meaning varies by company; bounded 2-30% of premium)"),
    "s3_premium": ("duration", ["SupplementaryInsuranceInformationPremiumRevenue"],
                   "Schedule III premium revenue (annual)"),
    "s3_losses": ("duration", ["SupplementaryInsuranceInformationBenefitsClaimsLossesAndSettlementExpense"],
                  "Schedule III benefits, claims, losses and settlement expense (annual)"),
    "s3_acq": ("duration", ["SupplementaryInsuranceInformationAmortizationOfDeferredPolicyAcquisitionCosts"],
               "Schedule III amortization of DAC (annual)"),
    "s3_other_opex": ("duration", ["SupplementaryInsuranceInformationOtherOperatingExpense"],
                      "Schedule III other operating expenses (annual)"),
    "nii": ("duration", ["NetInvestmentIncome"], "Net investment income"),
    "inv_gains": ("duration", ["GainLossOnInvestments", "RealizedInvestmentGainsLosses",
                               "MarketableSecuritiesRealizedGainLossExcludingOtherThanTemporaryImpairments"],
                  "Net investment gains and losses"),
    "net_income": ("duration", ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"],
                   "Net income attributable to the company"),
    "pretax_income": ("duration", [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ], "Pre-tax income from continuing operations"),
    "oci": ("duration", ["OtherComprehensiveIncomeLossNetOfTax",
                         "OtherComprehensiveIncomeLossNetOfTaxPortionAttributableToParent"],
            "Other comprehensive income, net of tax"),
    "dividends": ("duration", ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends", "DividendsCommonStockCash"],
                  "Dividends paid to common shareholders"),
    "buybacks": ("duration", ["PaymentsForRepurchaseOfCommonStock"], "Share repurchases"),
    # ---- balance sheet (instants)
    "equity": ("instant", ["StockholdersEquity"], "Shareholders' equity"),
    "assets": ("instant", ["Assets"], "Total assets"),
    "net_reserves": ("instant", ["LiabilityForUnpaidClaimsAndClaimsAdjustmentExpenseNet"],
                     "Loss and LAE reserves, net of reinsurance"),
    "gross_reserves": ("instant", ["LiabilityForClaimsAndClaimsAdjustmentExpense"],
                       "Loss and LAE reserves, gross"),
    "unearned_premiums": ("instant", ["UnearnedPremiums"], "Unearned premiums"),
    "investments": ("instant", ["Investments"], "Total investments"),
    "debt_afs": ("instant", ["AvailableForSaleSecuritiesDebtSecurities"], "Fixed maturities available for sale"),
    "equity_securities": ("instant", ["EquitySecuritiesFvNi", "AvailableForSaleSecuritiesEquitySecurities",
                                      "MarketableSecuritiesEquitySecurities"], "Equity securities"),
    "aoci": ("instant", ["AccumulatedOtherComprehensiveIncomeLossNetOfTax"], "Accumulated other comprehensive income"),
    "reinsurance_recoverable": ("instant", ["ReinsuranceRecoverables", "ReinsuranceRecoverablesOnPaidAndUnpaidLosses",
                                            "ReinsuranceRecoverableForUnpaidClaimsAndClaimsAdjustments"],
                                "Reinsurance recoverables"),
    "debt": ("instant", ["LongTermDebt", "SeniorNotes", "DebtInstrumentCarryingAmount", "LongTermDebtNoncurrent"],
             "Debt"),
}

# AI-indicator capex (hyperscalers): duration concepts
AI_CONCEPTS: dict[str, tuple[str, list[str], str]] = {
    "capex": ("duration", ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
              "Capital expenditure"),
    "revenue": ("duration", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"], "Revenue"),
    "ocf": ("duration", ["NetCashProvidedByUsedInOperatingActivities"], "Operating cash flow"),
}


def concept_rows() -> list[tuple[str, str, int, str, str]]:
    rows = []
    for table in (CONCEPTS, AI_CONCEPTS):
        for concept, (kind, tags, desc) in table.items():
            for i, tag in enumerate(tags):
                rows.append((concept, tag, i + 1, kind, desc))
    return rows
