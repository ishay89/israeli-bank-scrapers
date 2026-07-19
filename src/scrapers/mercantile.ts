import moment from 'moment';
import { getDebug } from '../helpers/debug';
import { fetchGetWithinPage, fetchPostWithinPage } from '../helpers/fetch';
import DiscountScraper from './discount';
import {
  type DebtObligation,
  type InvestmentPortfolio,
  type PortfolioHolding,
  type ScraperScrapingResult,
} from './interface';

const API_URL = 'https://start.telebank.co.il/Titan/gatewayAPI';
const debug = getDebug('mercantile');

type BankValue = string | number | null | undefined;
type BankRecord = Record<string, unknown>;

interface MercantileAccountData {
  UserAccountsData?: {
    UserAccounts?: Array<{ NewAccountInfo?: BankRecord }>;
  };
}

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textValue(value: unknown, fallback = ''): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  return `${value}`.trim();
}

function bankDate(value: unknown): string | undefined {
  const raw = textValue(value);
  if (!raw || raw === '0') return undefined;
  const parsed = moment(raw, ['YYYYMMDD', 'DD/MM/YYYY', 'YYYY-MM-DD', moment.ISO_8601], true);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : undefined;
}

function asRecords(value: unknown): BankRecord[] {
  if (Array.isArray(value)) return value as BankRecord[];
  return value && typeof value === 'object' ? [value as BankRecord] : [];
}

function loanEntries(payload: unknown): BankRecord[] {
  const root = payload as { LoansQuery?: { LoanDetailsBlock?: { LoanEntry?: unknown } } };
  return asRecords(root?.LoansQuery?.LoanDetailsBlock?.LoanEntry);
}

function mortgageEntries(payload: unknown): BankRecord[] {
  const root = payload as {
    MortgagesDetails?: { MortgagesBlock?: { MortgageEntry?: unknown } };
  };
  return asRecords(root?.MortgagesDetails?.MortgagesBlock?.MortgageEntry);
}

export function convertMercantileLoans(payload: unknown, sourceAccountNumber: string): DebtObligation[] {
  return loanEntries(payload)
    .map((loan, index) => ({
      sourceAccountNumber,
      externalId: textValue(loan.LoanAccount, `loan-${index}`),
      type: 'loan' as const,
      name: textValue(loan.LoanName, 'Loan'),
      currency: textValue(loan.LoanCurrencyCode, 'ILS'),
      originalAmount: numberValue(loan.LoanAmount as BankValue),
      outstandingBalance: numberValue(
        (loan.TotalLoanBalance ?? loan.LoanBalance ?? loan.PrincipalBalance) as BankValue,
      ),
      nextPaymentAmount: numberValue(loan.NextPayment as BankValue),
      nextPaymentDate: bankDate(loan.NextPaymentDate as BankValue),
      currentMonthPayment: numberValue(loan.CurrentMonthPayment as BankValue),
      paymentsMade: numberValue(loan.NumOfPaymentsMade as BankValue),
      paymentsRemaining: numberValue(loan.NumOfPaymentsRemained as BankValue),
      paymentsTotal: numberValue(loan.NumOfPayments as BankValue),
      interestRate: numberValue(loan.TotalInterestRate as BankValue),
    }))
    .filter(loan => (loan.outstandingBalance ?? 0) > 0 || (loan.paymentsRemaining ?? 0) > 0);
}

export function convertMercantileMortgages(payload: unknown, fallbackAccountNumber: string): DebtObligation[] {
  const debts: DebtObligation[] = [];
  for (const mortgage of mortgageEntries(payload)) {
    const details = mortgage.MortgageDetailsBlock as { LoanEntry?: unknown } | undefined;
    const accountNumber = textValue(
      (mortgage.AccountID ?? mortgage.MortgageAccountNumber) as BankValue,
      fallbackAccountNumber,
    );
    for (const [index, loan] of asRecords(details?.LoanEntry).entries()) {
      const paymentsRemaining = numberValue(loan.NumOfPaymentsRemained as BankValue);
      const outstandingBalance = numberValue(
        (loan.TotalLoanBalance ?? loan.LoanDebtBalanceAndArrears ?? loan.LoanDebtBalance) as BankValue,
      );
      if ((outstandingBalance ?? 0) <= 0 && (paymentsRemaining ?? 0) <= 0) continue;
      debts.push({
        sourceAccountNumber: fallbackAccountNumber,
        externalId: `${accountNumber}:${textValue(loan.LoanAccount, String(index))}`,
        type: 'mortgage',
        name: textValue(loan.LoanName, 'Mortgage'),
        currency: textValue(loan.LoanCurrencyCode, 'ILS'),
        originalAmount: numberValue(loan.LoanAmount as BankValue),
        outstandingBalance,
        nextPaymentAmount: numberValue(loan.NextPayment as BankValue),
        nextPaymentDate: bankDate(loan.NextPaymentDate as BankValue),
        currentMonthPayment: numberValue(loan.CurrentMonthPayment as BankValue),
        paymentsMade: numberValue(loan.NumOfPaymentsMade as BankValue),
        paymentsRemaining,
        paymentsTotal: numberValue(loan.NumOfPayments as BankValue),
        interestRate: numberValue(loan.TotalInterestRate as BankValue),
      });
    }
  }
  return debts;
}

export function convertMercantilePortfolio(payload: unknown, sourceAccountNumber: string): InvestmentPortfolio | null {
  const root = (payload as { CurrentSecuritiesPortfolio?: BankRecord })?.CurrentSecuritiesPortfolio;
  if (!root) return null;
  const totalValue = numberValue((root.PortfolioValueTitan ?? root.PortfolioValue) as BankValue) ?? 0;
  const securities = asRecords(root.SecuritiesEntry);
  if (totalValue === 0 && securities.length === 0) return null;

  const holdings: PortfolioHolding[] = securities.map((security, index) => ({
    externalId: textValue(security.SecurityNumber, `${textValue(security.Symbol, 'security')}-${index}`),
    name: textValue(security.SecurityName, textValue(security.Symbol, 'Security')),
    symbol: textValue(security.Symbol) || undefined,
    quantity: numberValue(security.CurrentUnits as BankValue),
    marketValue: numberValue((security.TmuraTitan ?? security.Tmura) as BankValue),
    currency: textValue(security.CurrencyCode, 'ILS'),
    percentOfPortfolio: numberValue(security.PercentFromPortfolio as BankValue),
    dailyChangePercent: numberValue(security.DailyChangePercent as BankValue),
    dailyProfitLoss: numberValue(security.DailyLossOrProfitAmount as BankValue),
  }));

  return {
    sourceAccountNumber,
    externalId: sourceAccountNumber,
    currency: 'ILS',
    totalValue,
    availableBalance: numberValue(root.OperationsAvailableBalance as BankValue),
    accountBalance: numberValue(root.AccountBalance as BankValue),
    dailyProfitLoss: numberValue(root.DailyPortfolioLossOrProfitAmount as BankValue),
    dailyProfitLossPercent: numberValue(root.DailyPortfolioLossOrProfitPercent as BankValue),
    holdings,
  };
}

type ScraperSpecificCredentials = { id: string; password: string; num: string };
class MercantileScraper extends DiscountScraper {
  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      ...super.getLoginOptions(credentials),
      loginUrl: 'https://start.telebank.co.il/login/?bank=m',
    };
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    const baseResult = await super.fetchData();
    if (!baseResult.success) return baseResult;

    const accountInfo = await fetchGetWithinPage<MercantileAccountData>(this.page, `${API_URL}/userAccountsData`);
    const accounts = accountInfo?.UserAccountsData?.UserAccounts ?? [];
    const debts: DebtObligation[] = [];
    const portfolios: InvestmentPortfolio[] = [];
    let debtsAvailable = true;
    let portfoliosAvailable = true;

    for (const account of accounts) {
      const info = account.NewAccountInfo ?? {};
      const accountNumber = textValue(info.AccountID as BankValue);
      if (!accountNumber) continue;

      try {
        const loans = await fetchGetWithinPage(this.page, `${API_URL}/onlineLoans/loansQuery/${accountNumber}`);
        debts.push(...convertMercantileLoans(loans, accountNumber));

        const mortgageList = await fetchGetWithinPage<{
          MortgageAccountsList?: { AccountList?: { AccountEntry?: unknown } };
        }>(this.page, `${API_URL}/mortgage/accountsList/${accountNumber}`);
        const mortgageAccounts = asRecords(mortgageList?.MortgageAccountsList?.AccountList?.AccountEntry).map(entry => {
          const oldInfo = (entry.OldAccountInfo ?? {}) as BankRecord;
          const newInfo = (entry.NewAccountInfo ?? entry) as BankRecord;
          return {
            BankID: oldInfo.BankID ?? newInfo.BankID,
            BranchID: oldInfo.BranchID ?? newInfo.BranchID,
            AccountType: oldInfo.AccountType ?? newInfo.AccountType,
            CurrencyID: oldInfo.CurrencyID ?? newInfo.CurrencyID,
            AccountID: oldInfo.AccountID ?? newInfo.AccountID,
          };
        });
        if (mortgageAccounts.length > 0) {
          const mortgageDetails = await fetchPostWithinPage(
            this.page,
            `${API_URL}/mortgage/details`,
            {
              MortgageAccountBlock: { MortgageAccountEntry: mortgageAccounts },
            },
            { 'Content-Type': 'application/json;charset=UTF-8' },
          );
          const convertedMortgages = convertMercantileMortgages(mortgageDetails, accountNumber);
          if (convertedMortgages.length === 0) {
            const entries = mortgageEntries(mortgageDetails);
            const detailCounts = entries.map(entry => {
              const details = entry.MortgageDetailsBlock as { LoanEntry?: unknown } | undefined;
              return asRecords(details?.LoanEntry).length;
            });
            const topKeys = mortgageDetails && typeof mortgageDetails === 'object' ? Object.keys(mortgageDetails) : [];
            debug(
              `mortgage response mapped no tracks; keys=${topKeys.join(',')}; entries=${entries.length}; details=${detailCounts.join(',')}`,
            );
          }
          debts.push(...convertedMortgages);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug(`failed to fetch debts for account ${accountNumber}: ${message.split(', result:')[0]}`);
        debtsAvailable = false;
      }

      try {
        const portfolioResult = await fetchPostWithinPage(
          this.page,
          `${API_URL}/securities/portfolioInfo/currentSecuritiesPortfolio`,
          {
            AccountNumber: accountNumber,
            ReutersFlag: 'True',
            FetchBeginYearReturnFlag: 'True',
            LoaclRealTimeFlag: 'False',
            SecuritiesListFlag: 'True',
            ForeignRealTimeFlag: 'False',
            DailyPortfolioLossOrProfitFlag: 'True',
          },
          { 'Content-Type': 'application/json;charset=UTF-8' },
        );
        const portfolio = convertMercantilePortfolio(portfolioResult, accountNumber);
        if (!portfolio) {
          const topKeys = portfolioResult && typeof portfolioResult === 'object' ? Object.keys(portfolioResult) : [];
          const nested = (portfolioResult as { CurrentSecuritiesPortfolio?: unknown } | null)
            ?.CurrentSecuritiesPortfolio;
          const nestedKeys = nested && typeof nested === 'object' ? Object.keys(nested) : [];
          debug(
            `portfolio response had no data for account ${accountNumber}; keys=${topKeys.join(',')}; nested=${nestedKeys.join(',')}`,
          );
        }
        if (portfolio) portfolios.push(portfolio);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug(`failed to fetch portfolio for account ${accountNumber}: ${message.split(', result:')[0]}`);
        portfoliosAvailable = false;
      }
    }

    return {
      ...baseResult,
      debts: debtsAvailable ? debts : undefined,
      portfolios: portfoliosAvailable ? portfolios : undefined,
    };
  }
}

export default MercantileScraper;
