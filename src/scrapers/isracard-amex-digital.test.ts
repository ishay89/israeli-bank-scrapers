import moment from 'moment';
import {
  collectCards,
  resolveProcessedMoment,
  voucherToTransaction,
  approvalToTransaction,
} from './isracard-amex-digital';
import { TransactionStatuses } from '../transactions';

// Trimmed but real-shaped `GetCardList` roster response (card 1558, an Amex card whose upcoming
// charge is 02/08/2026, per the bank's own UI - not the 1st of the month).
const ROSTER_FIXTURE = {
  data: {
    cardsList: [
      {
        companyCode: '77',
        cardStatus: '0',
        cardSuffix: '1558',
        cardChargeNext: { period: 'Next', billingDate: '02/08/2026', workingDate: '02/08/2026' },
        cardChargeLast: { period: 'Last', billingDate: '02/07/2026', workingDate: '02/07/2026' },
      },
      {
        // No billing-date blocks at all - should fall back gracefully, not throw.
        companyCode: '77',
        cardStatus: '0',
        cardSuffix: '9999',
      },
    ],
  },
};

describe('collectCards', () => {
  test('reads the real billing day-of-month off cardChargeNext.billingDate', () => {
    const cards = collectCards(ROSTER_FIXTURE);
    const card1558 = cards.find(c => c.cardSuffix === '1558');
    expect(card1558?.billingDay).toBe(2);
  });

  test('falls back to null when the roster has no billing-date block for a card', () => {
    const cards = collectCards(ROSTER_FIXTURE);
    const card9999 = cards.find(c => c.cardSuffix === '9999');
    expect(card9999?.billingDay).toBeNull();
  });
});

describe('resolveProcessedMoment', () => {
  test('uses the real billing day instead of the 1st of the month', () => {
    const result = resolveProcessedMoment(moment('2026-08-15'), 2);
    expect(result.date()).toBe(2);
    expect(result.month()).toBe(7); // August, 0-indexed
    expect(result.year()).toBe(2026);
  });

  test('falls back to the 1st of the month when no billing day is known', () => {
    const result = resolveProcessedMoment(moment('2026-08-15'), null);
    expect(result.date()).toBe(1);
  });

  test('clamps a billing day past the end of a shorter month', () => {
    const result = resolveProcessedMoment(moment('2026-02-15'), 31);
    expect(result.date()).toBe(28); // 2026 is not a leap year
    expect(result.month()).toBe(1); // stays in February, doesn't roll into March
  });
});

describe('voucherToTransaction', () => {
  test('bills on the given processed moment, not the 1st of the month', () => {
    const processedMoment = resolveProcessedMoment(moment('2026-08-15'), 2);
    const txn = voucherToTransaction(
      { purchaseDate: '24/07/2026', businessName: 'test', billingAmount: 100 },
      processedMoment,
    );
    expect(txn).not.toBeNull();
    const processed = moment(txn!.processedDate);
    expect(processed.date()).toBe(2);
    expect(processed.month()).toBe(7);
  });

  test('returns null when the voucher has no purchase date', () => {
    const txn = voucherToTransaction({ businessName: 'test' }, moment('2026-08-02'));
    expect(txn).toBeNull();
  });

  // Real production case: a standing-order (הוראת קבע) voucher reported its original
  // authorization date - a full year before the cycle it was billed under - instead of an actual
  // purchase date for this cycle.
  test('falls back to a stand-in date and Pending status when the purchase date is implausibly stale', () => {
    const processedMoment = resolveProcessedMoment(moment('2026-08-15'), 2);
    const txn = voucherToTransaction(
      { purchaseDate: '27/07/2025', businessName: 'ANTHROPIC* CLAUDE SUB', billingAmount: 61.16 },
      processedMoment,
    );
    expect(txn).not.toBeNull();
    expect(txn!.status).toBe(TransactionStatuses.Pending);
    const date = moment(txn!.date);
    expect(date.year()).toBe(2026);
    expect(date.month()).toBe(6); // July, one month before the August charge date
  });

  test('trusts a purchase date within the plausible window and marks it Completed', () => {
    const processedMoment = resolveProcessedMoment(moment('2026-08-15'), 2);
    const txn = voucherToTransaction(
      { purchaseDate: '27/07/2026', businessName: 'test', billingAmount: 50 },
      processedMoment,
    );
    expect(txn!.status).toBe(TransactionStatuses.Completed);
    expect(moment(txn!.date).format('DD/MM/YYYY')).toBe('27/07/2026');
  });
});

describe('approvalToTransaction', () => {
  test('maps an approved-but-not-yet-cleared transaction and always marks it Pending', () => {
    const processedMoment = resolveProcessedMoment(moment('2026-08-15'), 2);
    const txn = approvalToTransaction(
      {
        purchaseDate: '29/07/2026',
        businessName: 'OPENAI *CHATGPT SUBSCR',
        ilsBillingAmount: 61.16,
        originalAmount: 20,
        currencyIso: 'USD',
        confirmationNumber: '10339013:19',
      },
      processedMoment,
    );
    expect(txn).not.toBeNull();
    expect(txn!.status).toBe(TransactionStatuses.Pending);
    expect(txn!.chargedAmount).toBe(-61.16);
    expect(txn!.originalAmount).toBe(-20);
    expect(txn!.originalCurrency).toBe('USD');
    expect(moment(txn!.date).format('DD/MM/YYYY')).toBe('29/07/2026');
  });

  test('returns null when the approval has no purchase date', () => {
    const txn = approvalToTransaction({ businessName: 'test' }, moment('2026-08-02'));
    expect(txn).toBeNull();
  });
});
