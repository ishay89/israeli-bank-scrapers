import LeumiScraper, { convertLeumiPortfolio } from './leumi';
import { SCRAPERS } from '../definitions';
import { getDebug } from '../helpers/debug';
import { exportTransactions, extendAsyncTimeout, getTestsConfig, maybeTestCompanyAPI } from '../tests/tests-utils';
import { LoginResults } from './base-scraper-with-browser';

const COMPANY_ID = 'leumi'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();
const debug = getDebug('leumi-test');

describe('Leumi legacy scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.leumi).toBeDefined();
    expect(SCRAPERS.leumi.loginFields).toContain('username');
    expect(SCRAPERS.leumi.loginFields).toContain('password');
  });

  test('converts portfolio statement and holdings', () => {
    const portfolio = convertLeumiPortfolio(
      { PortfolioId: 'P-1', PFValue: 120000, PLShekel: 350, DailyChangePercent: 0.3 },
      {
        data: {
          UserStatement: {
            PortfolioIndex: 1,
            PortfolioValue: 121000,
            SumDailyProfit: 420,
            DailyChangePercent: 0.35,
            CurrencySymbol: '₪',
            DataSource: [
              {
                PaperId: 42,
                PaperName: 'Index fund',
                Symbol: 'IDX',
                Amount: 10,
                Value: 121000,
                Percent: 100,
                ChangePercent: 0.5,
              },
            ],
          },
        },
      },
    );

    expect(portfolio).toMatchObject({
      sourceAccountNumber: 'P-1',
      externalId: 'P-1',
      currency: 'ILS',
      totalValue: 121000,
      dailyProfitLoss: 420,
      dailyProfitLossPercent: 0.35,
    });
    expect(portfolio?.holdings[0]).toMatchObject({
      externalId: '42',
      name: 'Index fund',
      symbol: 'IDX',
      quantity: 10,
      marketValue: 121000,
      percentOfPortfolio: 100,
      dailyChangePercent: 0.5,
    });
  });

  test('returns null for an empty portfolio statement', () => {
    expect(
      convertLeumiPortfolio({ PortfolioId: 'P-1' }, { data: { UserStatement: { PortfolioValue: 0, DataSource: [] } } }),
    ).toBeNull();
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password"',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new LeumiScraper(options);

      const result = await scraper.scrape({ username: 'e10s12', password: '3f3ss3d' });

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
  );

  maybeTestCompanyAPI(COMPANY_ID)('should scrape transactions', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new LeumiScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.leumi);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    exportTransactions(COMPANY_ID, result.accounts || []);

    // Validate savings accounts if they exist
    expect(result.accounts).toBeDefined();
    const savingsAccounts = result.accounts?.filter(account => account.savingsAccount === true);

    debug('Total accounts:', result.accounts?.length);
    debug('Savings accounts found:', savingsAccounts?.length);

    if (savingsAccounts && savingsAccounts.length > 0) {
      debug('Savings account details:');
      savingsAccounts.forEach(account => {
        debug(`  - Account: ${account.accountNumber}, Balance: ${account.balance}`);
      });

      // Verify savings account properties
      savingsAccounts.forEach(account => {
        expect(account.savingsAccount).toBe(true);
        expect(account.accountNumber).toMatch(/ID/);
        expect(account.balance).toBeDefined();
        expect(account.txns).toBeDefined();
      });
    } else {
      debug('No savings accounts found - this may be expected if the test account has no deposits');
    }
  });
});
