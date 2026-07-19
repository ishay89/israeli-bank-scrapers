import MercantileScraper, {
  convertMercantileLoans,
  convertMercantileMortgages,
  convertMercantilePortfolio,
} from './mercantile';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../tests/tests-utils';
import { SCRAPERS } from '../definitions';
import { LoginResults } from './base-scraper-with-browser';

const COMPANY_ID = 'mercantile'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();

describe('Mercantile legacy scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.mercantile).toBeDefined();
    expect(SCRAPERS.mercantile.loginFields).toContain('id');
    expect(SCRAPERS.mercantile.loginFields).toContain('password');
    expect(SCRAPERS.mercantile.loginFields).toContain('num');
  });

  test('converts loans and keeps their next payment', () => {
    const [loan] = convertMercantileLoans(
      {
        LoansQuery: {
          LoanDetailsBlock: {
            LoanEntry: {
              LoanAccount: 'L-1',
              LoanName: 'Personal loan',
              LoanCurrencyCode: 'ILS',
              LoanAmount: 50000,
              TotalLoanBalance: 32000,
              NextPayment: 1250,
              NextPaymentDate: '20260801',
              NumOfPaymentsRemained: 24,
              TotalInterestRate: 6.2,
            },
          },
        },
      },
      '123',
    );

    expect(loan).toMatchObject({
      sourceAccountNumber: '123',
      externalId: 'L-1',
      type: 'loan',
      outstandingBalance: 32000,
      nextPaymentAmount: 1250,
      nextPaymentDate: '2026-08-01',
      paymentsRemaining: 24,
    });
  });

  test('converts active mortgage tracks and drops paid tracks', () => {
    const debts = convertMercantileMortgages(
      {
        MortgagesDetails: {
          MortgagesBlock: {
            MortgageEntry: {
              AccountID: 'M-1',
              MortgageDetailsBlock: {
                LoanEntry: [
                  {
                    LoanAccount: 'A',
                    LoanName: 'Fixed',
                    TotalLoanBalance: 400000,
                    NextPayment: 2800,
                    NumOfPaymentsRemained: 190,
                  },
                  { LoanAccount: 'B', LoanName: 'Paid', TotalLoanBalance: 0, NumOfPaymentsRemained: 0 },
                ],
              },
            },
          },
        },
      },
      '123',
    );

    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ type: 'mortgage', externalId: 'M-1:A', nextPaymentAmount: 2800 });
  });

  test('converts a securities portfolio and holdings', () => {
    const portfolio = convertMercantilePortfolio(
      {
        CurrentSecuritiesPortfolio: {
          PortfolioValueTitan: 120000,
          OperationsAvailableBalance: 8000,
          DailyPortfolioLossOrProfitAmount: 350,
          SecuritiesEntry: [{ SecurityNumber: '42', SecurityName: 'Index fund', CurrentUnits: 10, TmuraTitan: 120000 }],
        },
      },
      '123',
    );

    expect(portfolio).toMatchObject({ totalValue: 120000, availableBalance: 8000, dailyProfitLoss: 350 });
    expect(portfolio?.holdings[0]).toMatchObject({ externalId: '42', name: 'Index fund', marketValue: 120000 });
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password"',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new MercantileScraper(options);

      const result = await scraper.scrape(testsConfig.credentials.mercantile);

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
  );

  maybeTestCompanyAPI(COMPANY_ID)('should scrape transactions"', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new MercantileScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.mercantile);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    exportTransactions(COMPANY_ID, result.accounts || []);
  });
});
