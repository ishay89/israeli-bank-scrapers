import MizrahiScraper, {
  convertMizrahiLoans,
  convertPendingRow,
  type LoanGrid,
  nextScheduledPayment,
  parseAmount,
  parseMizrahiAmount,
} from './mizrahi';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../tests/tests-utils';
import { SCRAPERS } from '../definitions';
import { ISO_DATE_REGEX } from '../constants';
import { LoginResults } from './base-scraper-with-browser';
import { type TransactionsAccount } from '../transactions';
import debug from 'debug';
import { type ScraperOptions } from './interface';

debug.enable('israeli-bank-scrapers:mizrahi');

const COMPANY_ID = 'mizrahi'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();

describe('Mizrahi scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test.each([
    ['1,234.56', 1234.56],
    ['-1,234.56', -1234.56],
    ['1,234.56-', -1234.56],
    ['₪ 12,000.00', 12000],
    ['0.00', 0],
    [' 5 ', 5],
  ])('parseMizrahiAmount(%p) -> %p', (input, expected) => {
    expect(parseMizrahiAmount(input)).toBe(expected);
  });

  test.each([[undefined], [null], [''], ['--'], ['₪'], [NaN]])('parseMizrahiAmount(%p) -> undefined', input => {
    expect(parseMizrahiAmount(input)).toBeUndefined();
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.mizrahi).toBeDefined();
    expect(SCRAPERS.mizrahi.loginFields).toContain('username');
    expect(SCRAPERS.mizrahi.loginFields).toContain('password');
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new MizrahiScraper(options);

      const result = await scraper.scrape({ username: 'e10s12', password: '3f3ss3d' });

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
  );

  maybeTestCompanyAPI(COMPANY_ID)('should scrape transactions', async () => {
    const options: ScraperOptions = {
      ...testsConfig.options,
      optInFeatures: [
        'mizrahi:pendingIfHasGenericDescription',
        'mizrahi:pendingIfHasGenericDescriptionWithDate',
        'mizrahi:pendingIfTodayTransaction',
      ],
      companyId: COMPANY_ID,
    };

    const scraper = new MizrahiScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.mizrahi);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();
    expect(result.accounts).toBeDefined();
    expect((result.accounts as any).length).toBeGreaterThan(0);
    const account: TransactionsAccount = (result as any).accounts[0];
    expect(account.accountNumber).not.toBe('');
    expect(account.txns[0].date).toMatch(ISO_DATE_REGEX);

    exportTransactions(COMPANY_ID, result.accounts || []);
  });
});

describe('parseAmount', () => {
  test('parses an integer string', () => {
    expect(parseAmount('12345')).toBe(12345);
  });

  test('parses a string with thousands separators', () => {
    expect(parseAmount('12,345.67')).toBe(12345.67);
  });

  test('parses a negative value', () => {
    expect(parseAmount('-1,234.5')).toBe(-1234.5);
  });

  test('strips a leading currency symbol', () => {
    expect(parseAmount('₪1,234.5')).toBe(1234.5);
  });

  test('strips a trailing currency symbol', () => {
    expect(parseAmount('1,234.5 ₪')).toBe(1234.5);
  });

  test('returns undefined for an empty string', () => {
    expect(parseAmount('')).toBeUndefined();
  });

  test('returns undefined for undefined', () => {
    expect(parseAmount(undefined)).toBeUndefined();
  });

  test('returns undefined for null', () => {
    expect(parseAmount(null)).toBeUndefined();
  });

  test('returns undefined for garbage input', () => {
    expect(parseAmount('abc')).toBeUndefined();
  });

  test('applies the sign for a trailing minus', () => {
    expect(parseAmount('1,234.56-')).toBe(-1234.56);
  });

  test('applies the sign for parenthesized negatives', () => {
    expect(parseAmount('(1,234.56)')).toBe(-1234.56);
  });

  test('applies the sign for a leading minus with a thousands separator', () => {
    expect(parseAmount('-1,234.56')).toBe(-1234.56);
  });

  test('strips bidi marks around the amount', () => {
    expect(parseAmount('‏1,234.56‎')).toBe(1234.56);
  });

  test('returns undefined for a lone minus sign', () => {
    expect(parseAmount('-')).toBeUndefined();
  });

  test('returns undefined for whitespace-only input', () => {
    expect(parseAmount('   ')).toBeUndefined();
  });

  test('returns undefined for a minus sign embedded in letters', () => {
    expect(parseAmount('abc-5')).toBeUndefined();
  });

  test('returns undefined for a minus sign embedded between digits', () => {
    expect(parseAmount('12-34')).toBeUndefined();
  });

  test('returns undefined for a value with multiple decimal points', () => {
    expect(parseAmount('1.2.3')).toBeUndefined();
  });

  test('returns undefined for exponential notation', () => {
    expect(parseAmount('1e5')).toBeUndefined();
  });

  test('parses a leading-dot decimal', () => {
    expect(parseAmount('.5')).toBe(0.5);
  });

  test('parses a realistic Yitra-like balance string', () => {
    expect(parseAmount('12,345.67 ₪')).toBe(12345.67);
  });

  test('strips a leading currency symbol with a leading minus', () => {
    expect(parseAmount('₪ -12')).toBe(-12);
  });

  test('strips a trailing currency symbol with a trailing minus', () => {
    expect(parseAmount('12- ₪')).toBe(-12);
  });

  test('maps a unicode minus sign after the amount', () => {
    expect(parseAmount('1,234.56−')).toBe(-1234.56);
  });

  test('returns undefined for Hebrew text preceding the amount', () => {
    expect(parseAmount('יתרת חובה 1,234.56')).toBeUndefined();
  });

  test('returns undefined for Hebrew text following the amount', () => {
    expect(parseAmount('1,234.56 חובה')).toBeUndefined();
  });

  test('returns undefined for multiple parenthesized groups', () => {
    expect(parseAmount('(1)+(2)')).toBeUndefined();
  });
});

describe('convertPendingRow', () => {
  test('parses a debit row as a negative amount', () => {
    const txn = convertPendingRow(['15/09/26', 'חיוב ויזה כאל עתידי', "ש''ח", '', '6,883.17', '1', '002', '']);
    expect(txn?.chargedAmount).toBe(-6883.17);
    expect(txn?.status).toBe('pending');
  });

  test('parses a credit row as a positive amount', () => {
    const txn = convertPendingRow(['10/09/26', 'desc', "ש''ח", '250.00', '', '1', '001', '']);
    expect(txn?.chargedAmount).toBe(250);
  });

  test('returns undefined for a row with an empty date', () => {
    const txn = convertPendingRow(['', 'desc', "ש''ח", '', '6,883.17', '1', '002', '']);
    expect(txn).toBeUndefined();
  });

  test('returns undefined for a row with no parsable amount', () => {
    const txn = convertPendingRow(['15/09/26', 'desc', "ש''ח", '', '', '1', '002', '']);
    expect(txn).toBeUndefined();
  });
});

// Visible columns of the live P060.aspx grid (hidden rate-breakdown columns already dropped).
const LOANS_GRID: LoanGrid = {
  headers: [
    'מספר הלוואה',
    'סוג הלוואה',
    'תאריך ערך',
    'תאריך סיום',
    '% ריבית',
    'סכום הלוואה מקורי',
    'יתרה משוערכת',
    'מטרת הלוואה',
    '\u00a0',
  ],
  rows: [
    [
      '628401',
      'הצט.מנהלים קצר',
      '\u00a0 \n 11/10/26',
      '22/10/31',
      '7.75',
      ' 40,000.00',
      ' 40,111.94',
      'צריכה שוטפת של משק ה',
      'לוח סילוקין',
    ],
  ],
};

describe('convertMizrahiLoans', () => {
  test('converts a shekel loan row', () => {
    expect(convertMizrahiLoans(LOANS_GRID, '493-325673')).toEqual([
      {
        sourceAccountNumber: '493-325673',
        externalId: '628401',
        type: 'loan',
        name: 'הצט.מנהלים קצר',
        currency: 'ILS',
        originalAmount: 40000,
        outstandingBalance: 40111.94,
        interestRate: 7.75,
      },
    ]);
  });

  test('returns no loans for a grid without rows', () => {
    expect(convertMizrahiLoans({ ...LOANS_GRID, rows: [] }, '1')).toEqual([]);
  });

  test('throws when the layout lost an identifying column', () => {
    const headers = LOANS_GRID.headers.map(h => (h === 'יתרה משוערכת' ? 'יתרה' : h));
    expect(() => convertMizrahiLoans({ ...LOANS_GRID, headers }, '1')).toThrow(/יתרה משוערכת/);
  });
});

describe('nextScheduledPayment', () => {
  const schedule: LoanGrid = {
    headers: ['מספר תשלום', 'תאריך חיוב', 'תשלום על חשבון הקרן', 'תשלום על חשבון הריבית', 'סך החזר חודשי', 'יתרת הקרן'],
    rows: [
      ['1', '22/11/26', '547.95', '353.05', '901.00', '39,452.05'],
      ['2', '22/12/26', '551.48', '254.80', '806.28', '38,900.57'],
    ],
  };

  test('returns the first payment on or after today', () => {
    expect(nextScheduledPayment(schedule, new Date(2026, 9, 25))).toEqual({
      nextPaymentAmount: 901,
      nextPaymentDate: '2026-11-22',
    });
  });

  test('counts a payment due today as the next one', () => {
    expect(nextScheduledPayment(schedule, new Date(2026, 10, 22, 15))?.nextPaymentDate).toBe('2026-11-22');
  });

  test('skips payments already charged', () => {
    expect(nextScheduledPayment(schedule, new Date(2026, 10, 23))?.nextPaymentAmount).toBe(806.28);
  });

  test('returns undefined when the page holds no upcoming payment', () => {
    expect(nextScheduledPayment(schedule, new Date(2027, 0, 1))).toBeUndefined();
  });
});
