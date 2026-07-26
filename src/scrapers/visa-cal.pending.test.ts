import { TransactionStatuses } from '../transactions';
import { convertParsedDataToTransactions } from './visa-cal';

// Minimal fixtures - only the fields `convertParsedDataToTransactions` actually reads are
// populated; the rest of each real API shape is irrelevant to this logic and cast away.

function pendingTransaction(overrides: Record<string, unknown> = {}) {
  return {
    merchantName: 'ארקפה שוסטר',
    trnPurchaseDate: '2026-07-26T00:00:00',
    trnAmt: 24,
    trnCurrencySymbol: '₪',
    trnTypeCode: '5',
    trnType: 'regular',
    branchCodeDesc: '',
    numberOfPayments: 0,
    transTypeCommentDetails: [],
    // no `debCrdDate` - that's what marks a transaction as pending (see `isPending`).
    ...overrides,
  };
}

function completedTransaction(overrides: Record<string, unknown> = {}) {
  return {
    trnIntId: '123',
    trnPurchaseDate: '2026-07-02T00:00:00',
    debCrdDate: '2026-08-02T00:00:00',
    debCrdCurrencySymbol: '₪',
    amtBeforeConvAndIndex: 9952.68,
    trnAmt: 9952.68,
    trnCurrencySymbol: '₪',
    trnTypeCode: '5',
    trnType: 'regular',
    branchCodeDesc: '',
    numOfPayments: 0,
    curPaymentNum: 0,
    transTypeCommentDetails: [],
    ...overrides,
  };
}

function dataFixture(transactions: unknown[]) {
  return [
    {
      result: {
        bankAccounts: [
          {
            debitDates: [{ transactions }],
            immidiateDebits: { totalDebits: [], debitDays: [] },
          },
        ],
        blockedCardInd: false,
      },
      statusCode: 1,
      statusDescription: '',
      statusTitle: '',
    },
  ] as any;
}

// Like `dataFixture` but with real billing dates on each debit-date bucket, mirroring the
// `debitDates[].date` the Cal API returns. Used to prove the next-debit date can be recovered
// from the card's own schedule when the frames endpoint supplies none.
function dataFixtureWithSchedule(debitDates: { date: string; transactions?: unknown[] }[]) {
  return [
    {
      result: {
        bankAccounts: [
          {
            debitDates: debitDates.map(d => ({ date: d.date, transactions: d.transactions ?? [] })),
            immidiateDebits: { totalDebits: [], debitDays: [] },
          },
        ],
        blockedCardInd: false,
      },
      statusCode: 1,
      statusDescription: '',
      statusTitle: '',
    },
  ] as any;
}

function pendingDataFixture(transactions: unknown[]) {
  return {
    result: { cardsList: [{ cardUniqueID: 'card-1', authDetalisList: transactions }] },
    statusCode: 1,
    statusDescription: '',
    statusTitle: '',
  } as any;
}

describe('convertParsedDataToTransactions - pending transaction billing date', () => {
  test('bills a pending transaction on the account next-debit date, not its own purchase date', () => {
    const result = convertParsedDataToTransactions(
      dataFixture([completedTransaction()]),
      pendingDataFixture([pendingTransaction()]),
      undefined,
      '2026-08-02T00:00:00',
    );

    const pending = result.find(t => t.status === TransactionStatuses.Pending);
    expect(pending).toBeDefined();
    // Whatever instant "2026-08-02T00:00:00" (local, no offset) resolves to on this machine -
    // the pending transaction must land on that exact instant, not its own purchase date.
    expect(pending!.processedDate).toBe(new Date('2026-08-02T00:00:00').toISOString());
    expect(pending!.processedDate).not.toBe(pending!.date);
  });

  test('falls back to the purchase date when no next-debit date is known', () => {
    const result = convertParsedDataToTransactions(
      dataFixture([]),
      pendingDataFixture([pendingTransaction()]),
      undefined,
      undefined,
    );

    const pending = result.find(t => t.status === TransactionStatuses.Pending);
    expect(pending?.processedDate).toBe(pending?.date);
  });

  test('derives the next-debit date from the card own billing schedule when the frames endpoint supplies none', () => {
    // Some cards' frames responses carry no nextDebitDate and no nextTotalDebitDateForAccount, so
    // the caller passes undefined. The card's own completed data still carries its billing schedule
    // in debitDates[].date - the earliest date on or after the purchase (2026-07-26) is the cycle
    // the pending charge will actually post in.
    const result = convertParsedDataToTransactions(
      dataFixtureWithSchedule([
        { date: '2026-07-02T00:00:00' }, // last cycle, already billed - before the purchase
        { date: '2026-08-02T00:00:00' }, // next cycle - the real next debit date
      ]),
      pendingDataFixture([pendingTransaction()]),
      undefined,
      undefined,
    );

    const pending = result.find(t => t.status === TransactionStatuses.Pending);
    expect(pending).toBeDefined();
    expect(pending!.processedDate).toBe(new Date('2026-08-02T00:00:00').toISOString());
    expect(pending!.processedDate).not.toBe(pending!.date);
  });

  test('a passed next-debit date still wins over the derived schedule date', () => {
    const result = convertParsedDataToTransactions(
      dataFixtureWithSchedule([{ date: '2026-09-02T00:00:00' }]),
      pendingDataFixture([pendingTransaction()]),
      undefined,
      '2026-08-02T00:00:00',
    );

    const pending = result.find(t => t.status === TransactionStatuses.Pending);
    expect(pending!.processedDate).toBe(new Date('2026-08-02T00:00:00').toISOString());
  });

  test('falls back to the purchase date when every scheduled debit date is before the purchase', () => {
    const result = convertParsedDataToTransactions(
      dataFixtureWithSchedule([{ date: '2026-06-02T00:00:00' }, { date: '2026-07-02T00:00:00' }]),
      pendingDataFixture([pendingTransaction()]), // purchased 2026-07-26, after every scheduled date
      undefined,
      undefined,
    );

    const pending = result.find(t => t.status === TransactionStatuses.Pending);
    expect(pending!.processedDate).toBe(pending!.date);
  });

  test('a pending and a completed transaction for the same cycle land on the same processed date', () => {
    const result = convertParsedDataToTransactions(
      dataFixture([completedTransaction()]),
      pendingDataFixture([pendingTransaction()]),
      undefined,
      '2026-08-02T00:00:00',
    );

    expect(result).toHaveLength(2);
    const [a, b] = result;
    expect(a.processedDate).toBe(b.processedDate);
  });
});
