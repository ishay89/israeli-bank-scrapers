import IsracardScraper, { mergeUpcomingCharges } from './isracard';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../tests/tests-utils';
import { SCRAPERS } from '../definitions';
import { LoginResults } from './base-scraper-with-browser';
import { TransactionStatuses, TransactionTypes, type Transaction, type TransactionsAccount } from '../transactions';

const COMPANY_ID = 'isracard'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();

function pendingTxn(description: string): Transaction {
  return {
    type: TransactionTypes.Normal,
    date: '2026-07-29T00:00:00.000Z',
    processedDate: '2026-08-02T00:00:00.000Z',
    originalAmount: -61.16,
    originalCurrency: 'ILS',
    chargedAmount: -61.16,
    chargedCurrency: 'ILS',
    description,
    status: TransactionStatuses.Pending,
  };
}

describe('mergeUpcomingCharges', () => {
  test('appends not-yet-cleared transactions into the matching account by accountNumber', () => {
    const accounts: TransactionsAccount[] = [{ accountNumber: '4568', txns: [] }];
    const upcoming: TransactionsAccount[] = [{ accountNumber: '4568', txns: [pendingTxn('OPENAI *CHATGPT SUBSCR')] }];
    const merged = mergeUpcomingCharges(accounts, upcoming);
    expect(merged[0].txns).toHaveLength(1);
    expect(merged[0].txns[0].description).toBe('OPENAI *CHATGPT SUBSCR');
  });

  test('leaves accounts untouched when there is nothing upcoming for them', () => {
    const accounts: TransactionsAccount[] = [{ accountNumber: '4568', txns: [] }, { accountNumber: '1234', txns: [] }];
    const upcoming: TransactionsAccount[] = [{ accountNumber: '4568', txns: [pendingTxn('test')] }];
    const merged = mergeUpcomingCharges(accounts, upcoming);
    expect(merged.find(a => a.accountNumber === '1234')!.txns).toHaveLength(0);
  });

  test('is a no-op when there is nothing upcoming at all', () => {
    const accounts: TransactionsAccount[] = [{ accountNumber: '4568', txns: [] }];
    expect(mergeUpcomingCharges(accounts, [])).toBe(accounts);
  });

  test('drops a card with no matching legacy account instead of adding a bare account', () => {
    const accounts: TransactionsAccount[] = [{ accountNumber: '4568', txns: [] }];
    const upcoming: TransactionsAccount[] = [{ accountNumber: '9999', txns: [pendingTxn('test')] }];
    const merged = mergeUpcomingCharges(accounts, upcoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].accountNumber).toBe('4568');
  });
});

describe('Isracard legacy scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.isracard).toBeDefined();
    expect(SCRAPERS.isracard.loginFields).toContain('id');
    expect(SCRAPERS.isracard.loginFields).toContain('card6Digits');
    expect(SCRAPERS.isracard.loginFields).toContain('password');
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password"',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new IsracardScraper(options);

      const result = await scraper.scrape({ id: 'e10s12', password: '3f3ss3d', card6Digits: '123456' });

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
  );

  maybeTestCompanyAPI(COMPANY_ID)('should scrape transactions and balances', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new IsracardScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.isracard);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();
    result.accounts?.forEach(account => {
      expect(account.balance).toBeDefined();
      expect(account.cardFrame).toBeDefined();
    });

    exportTransactions(COMPANY_ID, result.accounts || []);
  });
});
