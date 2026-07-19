import BeinleumiScraper, { convertBeinleumiPortfolio } from './beinleumi';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../tests/tests-utils';
import { SCRAPERS } from '../definitions';
import { LoginResults } from './base-scraper-with-browser';

const COMPANY_ID = 'beinleumi'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();

describe('Beinleumi', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.beinleumi).toBeDefined();
    expect(SCRAPERS.beinleumi.loginFields).toContain('username');
    expect(SCRAPERS.beinleumi.loginFields).toContain('password');
  });

  test('converts portfolio summary and paginated holdings', () => {
    const portfolio = convertBeinleumiPortfolio(
      {
        portfolioValue: 150000,
        tradeBalance: 5000,
        dailyAmountChange: -250,
        dailyPercentageChange: -0.16,
        currencyISOCode: 'ILS',
      },
      [
        {
          pagedResult: {
            results: [
              {
                number: '42',
                name: 'Index fund',
                symbol: 'IDX',
                amount: 10,
                holdingValue: 149000,
                holdingValueInNis: 150000,
                portfolioPercentage: 100,
                percentDailyChange: -0.2,
              },
            ],
          },
        },
        {
          pagedResult: {
            // Repeated boundary rows from pagination must not create duplicate
            // natural keys in the Supabase holdings upsert batch.
            results: [{ number: '42', name: 'Index fund', holdingValueInNis: 150000 }],
          },
        },
      ],
      '123_456',
    );

    expect(portfolio).toMatchObject({
      sourceAccountNumber: '123_456',
      externalId: '123_456:securities',
      currency: 'ILS',
      totalValue: 150000,
      availableBalance: 5000,
      dailyProfitLoss: -250,
      dailyProfitLossPercent: -0.16,
    });
    expect(portfolio?.holdings[0]).toMatchObject({
      externalId: '42',
      name: 'Index fund',
      symbol: 'IDX',
      quantity: 10,
      marketValue: 150000,
      percentOfPortfolio: 100,
      dailyChangePercent: -0.2,
    });
    expect(portfolio?.holdings).toHaveLength(1);
  });

  test('returns null for an empty portfolio', () => {
    expect(convertBeinleumiPortfolio({ portfolioValue: 0 }, [{ pagedResult: { results: [] } }], '123')).toBeNull();
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new BeinleumiScraper(options);

      const result = await scraper.scrape({ username: 'e10s12', password: '3f3ss3d' });

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

    const scraper = new BeinleumiScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.beinleumi);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    exportTransactions(COMPANY_ID, result.accounts || []);
  });
});
