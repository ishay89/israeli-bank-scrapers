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
