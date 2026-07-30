/**
 * Fetches American Express cards through Isracard's modern **DigitalV3** web API
 * (`web.isracard.co.il`), reusing an already-authenticated Isracard session.
 *
 * Why this exists: Amex cards in Israel are operated by Isracard but sit under a different
 * issuer company code (77 vs Isracard's 11). The legacy `ProxyRequestHandler.ashx` API used by
 * the main Isracard/Amex scraper only returns the logged-in company's own cards, and the
 * dedicated Amex host (`he.americanexpress.co.il`) is Cloudflare-blocked from many IPs. The
 * DigitalV3 SPA on `web.isracard.co.il`, however, exposes *both* Isracard and Amex cards over
 * the same cookie session and is not blocked — so after a normal Isracard login we hop there and
 * pull the Amex cards from it.
 *
 * Cards are discovered by intercepting the SPA's own `GetCardList` roster response (no need to
 * reverse-engineer its request body); transactions come from `GetTransactionsList`.
 */
import moment, { type Moment } from 'moment';
import { type Page } from 'puppeteer';
import getAllMonthMoments from '../helpers/dates';
import { getDebug } from '../helpers/debug';
import { fetchPostWithinPage } from '../helpers/fetch';
import { randomDelay } from '../helpers/waiting';
import {
  TransactionStatuses,
  TransactionTypes,
  type Transaction,
  type TransactionInstallments,
  type TransactionsAccount,
} from '../transactions';

const debug = getDebug('isracard-amex-digital');

const WEB_BASE = 'https://web.isracard.co.il';
const TRANSACTIONS_PAGE = `${WEB_BASE}/transactions`;
const TRANSACTIONS_LIST_URL = `${WEB_BASE}/ocp/transactions/DigitalV3.Transactions/GetTransactionsList`;
// The card roster the SPA loads on the transactions page: `data.cardsList[]`, each entry carrying
// `cardSuffix` + `companyCode` (as a numeric string, e.g. "77") + `cardStatus`, plus a
// `cardChargeNext`/`cardChargeLast` block (`{ billingDate: "02/08/2026", ... }`) with the card's
// real billing-cycle day — used for `processedDate` instead of assuming the 1st of the month.
const CARD_LIST_MARKER = 'GetCardList';

export const AMEX_COMPANY_CODE = 77;
export const ISRACARD_COMPANY_CODE = 11;
const INSTALLMENTS_KEYWORD = 'תשלום';
const ALT_SHEKEL = 'ש"ח';
const RATE_LIMIT_MS = 1500;
const ROSTER_TIMEOUT_MS = 30000;
// A standing-order (הוראת קבע) voucher that hasn't been finalized yet can report its *original
// authorization date* instead of this cycle's actual charge date - seen a full year stale in
// production. Anything further than this from the cycle's charge date is treated as unreliable.
const PLAUSIBLE_DATE_WINDOW_DAYS = 45;

interface DigitalVoucher {
  purchaseDate?: string; // DD/MM/YYYY
  businessName?: string;
  billingAmount?: number;
  ilsAmount?: number;
  originalAmount?: number;
  originalCurrency?: string;
  originalCurrencyIso?: string;
  moreInfo?: string;
  voucherNumber?: number | string;
}

// A transaction the issuer has approved (funds authorized with the merchant) but not yet posted
// to a billing cycle - distinct from `DigitalVoucher`, which is already attached to a cycle. Seen
// under `data.approvals.approvedTransactions` in `GetTransactionsList`'s response. Foreign-currency
// purchases can sit here for days while the exchange rate settles, so they're invisible to the
// legacy `CardsTransactionsList` API (which only knows about cycle-attached transactions) until
// they clear and get folded into a `DigitalVoucher` on a later fetch.
interface ScrapedApproval {
  purchaseDate?: string; // DD/MM/YYYY
  businessName?: string;
  ilsBillingAmount?: number;
  originalAmount?: number;
  currencyIso?: string;
  confirmationNumber?: string | number;
  clearedDescription?: string;
}

interface DigitalCard {
  cardSuffix: string;
  companyCode: number;
  cardStatus: number;
  /** Day-of-month (1-31) the card's billing cycle charges on, e.g. 2. Null when the roster didn't
   *  carry a `cardChargeNext`/`cardChargeLast` block to read it from. */
  billingDay: number | null;
}

/** Coerces a value that may be a number or a numeric string to a number, else null. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? null : value;
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

/** Extracts the day-of-month from a `DD/MM/YYYY` string, or null if missing/unparseable. */
function parseDayOfMonth(dateStr: unknown): number | null {
  if (typeof dateStr !== 'string') {
    return null;
  }
  const day = parseInt(dateStr.split('/')[0] ?? '', 10);
  return Number.isFinite(day) && day >= 1 && day <= 31 ? day : null;
}

/** Reads the real billing day-of-month off a roster card entry's `cardChargeNext`/`cardChargeLast`
 *  blocks (e.g. `{ billingDate: "02/08/2026" }`), preferring the upcoming cycle. Both blocks report
 *  the same fixed cycle day in practice, so either is a reliable stand-in for months without their
 *  own block. */
function readBillingDay(obj: Record<string, unknown>): number | null {
  const next = obj.cardChargeNext as Record<string, unknown> | undefined;
  const last = obj.cardChargeLast as Record<string, unknown> | undefined;
  return parseDayOfMonth(next?.billingDate) ?? parseDayOfMonth(last?.billingDate);
}

/** Depth-first scan for card-identity objects anywhere in the roster response. Company code and
 *  status may arrive as numbers or numeric strings, so both are coerced. */
export function collectCards(node: unknown, out: DigitalCard[] = []): DigitalCard[] {
  if (Array.isArray(node)) {
    node.forEach(child => collectCards(child, out));
    return out;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const suffix = obj.cardSuffix ?? obj.card4Number;
    const companyCode = toNumber(obj.companyCode);
    if ((typeof suffix === 'string' || typeof suffix === 'number') && companyCode !== null) {
      out.push({
        cardSuffix: String(suffix),
        companyCode,
        cardStatus: toNumber(obj.cardStatus) ?? 0,
        billingDay: readBillingDay(obj),
      });
    }
    Object.values(obj).forEach(value => collectCards(value, out));
  }
  return out;
}

function dedupeCards(cards: DigitalCard[]): DigitalCard[] {
  const seen = new Map<string, DigitalCard>();
  for (const card of cards) {
    seen.set(`${card.companyCode}:${card.cardSuffix}`, card);
  }
  return [...seen.values()];
}

function getInstallments(moreInfo?: string): TransactionInstallments | undefined {
  if (!moreInfo || !moreInfo.includes(INSTALLMENTS_KEYWORD)) {
    return undefined;
  }
  const matches = moreInfo.match(/\d+/g);
  if (!matches || matches.length < 2) {
    return undefined;
  }
  return { number: parseInt(matches[0], 10), total: parseInt(matches[1], 10) };
}

function normalizeCurrency(currency?: string): string {
  if (!currency || currency === ALT_SHEKEL || currency === '₪') {
    return 'ILS';
  }
  return currency;
}

/** Resolves the billing month cursor to the card's real charge date: `billingDay` when known
 *  (clamped to the month's last day, e.g. a "31" cycle day in February), else the 1st of the
 *  month as a last-resort fallback for cards the roster gave no billing-date block for. */
export function resolveProcessedMoment(monthMoment: Moment, billingDay: number | null): Moment {
  if (!billingDay) {
    return monthMoment.clone().date(1);
  }
  const day = Math.min(billingDay, monthMoment.daysInMonth());
  return monthMoment.clone().date(day);
}

/**
 * Whether a purchase date is close enough to its billing cycle's charge date to be trusted. A
 * standing-order voucher still awaiting its first real charge can report the date its recurring
 * authorization was *originally set up*, sometimes a full year earlier, instead of this cycle's
 * purchase date - trusting it would hash the transaction into the wrong calendar day.
 */
function isPlausiblePurchaseDate(purchaseMoment: Moment, referenceMoment: Moment): boolean {
  return Math.abs(purchaseMoment.diff(referenceMoment, 'days')) <= PLAUSIBLE_DATE_WINDOW_DAYS;
}

/**
 * Maps one DigitalV3 voucher to the shared `Transaction` shape, mirroring the legacy
 * Isracard/Amex mapping: amounts are negated (outflows are negative), `date` is the purchase
 * date (matching what the bank UI shows), `chargedAmount` is the amount billed this cycle while
 * `originalAmount` is the full deal amount, and installments are parsed from the Hebrew memo.
 * `processedMoment` is the card's real charge date for this billing cycle (see
 * `resolveProcessedMoment`), not just the 1st of the billing month.
 *
 * When `purchaseDate` is missing or implausibly far from `processedMoment` (see
 * `isPlausiblePurchaseDate`), the voucher is treated as not yet finalized: `date` falls back to
 * one month before the charge date (this cycle's typical purchase-to-charge lag) and `status`
 * becomes `Pending` rather than `Completed`. Once the real date is reported on a later scrape, the
 * transaction hash changes and the stand-in row is reconciled away like any other pending charge.
 */
export function voucherToTransaction(voucher: DigitalVoucher, processedMoment: Moment): Transaction | null {
  if (!voucher.purchaseDate) {
    return null;
  }
  const installments = getInstallments(voucher.moreInfo);
  const billed = voucher.billingAmount ?? voucher.ilsAmount ?? 0;
  const original = voucher.originalAmount ?? billed;
  const purchaseMoment = moment(voucher.purchaseDate, 'DD/MM/YYYY');
  const plausible = isPlausiblePurchaseDate(purchaseMoment, processedMoment);
  const dateMoment = plausible ? purchaseMoment : processedMoment.clone().subtract(1, 'month');
  return {
    type: installments ? TransactionTypes.Installments : TransactionTypes.Normal,
    identifier: voucher.voucherNumber,
    date: dateMoment.toISOString(),
    processedDate: processedMoment.clone().toISOString(),
    originalAmount: -original,
    originalCurrency: normalizeCurrency(voucher.originalCurrencyIso ?? voucher.originalCurrency),
    chargedAmount: -billed,
    chargedCurrency: 'ILS',
    description: voucher.businessName ?? '',
    memo: voucher.moreInfo?.trim() || '',
    installments,
    status: plausible ? TransactionStatuses.Completed : TransactionStatuses.Pending,
  };
}

/**
 * Maps one `data.approvals.approvedTransactions` entry (approved but not yet posted to any
 * billing cycle - see `ScrapedApproval`) to the shared `Transaction` shape. Always `Pending`: by
 * definition these haven't cleared yet. `purchaseDate` is usually reliable here (unlike a stale
 * standing-order voucher), but gets the same plausibility fallback for safety.
 */
export function approvalToTransaction(approval: ScrapedApproval, processedMoment: Moment): Transaction | null {
  if (!approval.purchaseDate) {
    return null;
  }
  const purchaseMoment = moment(approval.purchaseDate, 'DD/MM/YYYY');
  const dateMoment = isPlausiblePurchaseDate(purchaseMoment, processedMoment)
    ? purchaseMoment
    : processedMoment.clone().subtract(1, 'month');
  const billed = approval.ilsBillingAmount ?? 0;
  const original = approval.originalAmount ?? billed;
  return {
    type: TransactionTypes.Normal,
    identifier: approval.confirmationNumber,
    date: dateMoment.toISOString(),
    processedDate: processedMoment.clone().toISOString(),
    originalAmount: -original,
    originalCurrency: normalizeCurrency(approval.currencyIso),
    chargedAmount: -billed,
    chargedCurrency: 'ILS',
    description: approval.businessName ?? '',
    memo: approval.clearedDescription?.trim() || '',
    status: TransactionStatuses.Pending,
  };
}

/**
 * Fetches one card's transactions for one billing cycle: vouchers already attached to the cycle
 * (`israelAbroadVouchers`, via `voucherToTransaction`) plus anything still awaiting clearance
 * (`approvals.approvedTransactions`, via `approvalToTransaction` - always `Pending`). The legacy
 * `CardsTransactionsList` API has no equivalent for the latter, so it's invisible to a card whose
 * primary history comes from there until it clears and becomes an ordinary voucher.
 */
async function fetchCardMonth(page: Page, card: DigitalCard, monthMoment: Moment): Promise<Transaction[]> {
  const billingMonth = monthMoment.clone().date(1).format('DD/MM/YYYY');
  const body = {
    card4Number: card.cardSuffix,
    isNextBillingDate: false,
    cardStatus: card.cardStatus,
    billingMonth,
    companyCode: card.companyCode,
    isPartner: false,
  };
  const result = await fetchPostWithinPage<{
    isSuccess?: boolean;
    data?: {
      israelAbroadVouchers?: { vouchers?: { israelAbroadVouchersList?: DigitalVoucher[] } };
      approvals?: { approvedTransactions?: ScrapedApproval[] };
    };
  }>(page, TRANSACTIONS_LIST_URL, body, { 'Content-Type': 'application/json' }, true);

  const vouchers = result?.data?.israelAbroadVouchers?.vouchers?.israelAbroadVouchersList ?? [];
  const approvals = result?.data?.approvals?.approvedTransactions ?? [];
  const processedMoment = resolveProcessedMoment(monthMoment, card.billingDay);
  const voucherTxns = vouchers.map(voucher => voucherToTransaction(voucher, processedMoment));
  const approvalTxns = approvals.map(approval => approvalToTransaction(approval, processedMoment));
  return [...voucherTxns, ...approvalTxns].filter((txn): txn is Transaction => txn !== null);
}

/**
 * Navigates to the DigitalV3 transactions page and discovers every card the logged-in session can
 * see (both Isracard's own cards and any Amex cards riding on the same login), by intercepting the
 * SPA's own `GetCardList` roster response. Returns `[]` (never throws) if the roster can't be
 * read, so a caller can safely treat this as best-effort.
 */
async function discoverDigitalV3Cards(page: Page): Promise<DigitalCard[]> {
  debug('navigating to DigitalV3 transactions page to discover cards');
  const rosterPromise = page
    .waitForResponse(response => response.url().includes(CARD_LIST_MARKER), { timeout: ROSTER_TIMEOUT_MS })
    .catch(() => null);
  await page.goto(TRANSACTIONS_PAGE, { waitUntil: 'load' }).catch(e => debug(`goto warning: ${(e as Error).message}`));

  const rosterResponse = await rosterPromise;
  if (!rosterResponse) {
    debug('did not observe a GetCardList response; no cards discovered');
    return [];
  }

  let roster: unknown = null;
  try {
    roster = await rosterResponse.json();
  } catch (e) {
    debug(`failed to parse roster response: ${(e as Error).message}`);
    return [];
  }

  const allCards = dedupeCards(collectCards(roster));
  debug(`roster cards: ${allCards.map(c => `${c.cardSuffix}(cc=${c.companyCode},st=${c.cardStatus})`).join(', ') || '(none)'}`);
  return allCards;
}

/**
 * Discovers the logged-in user's Amex cards (issuer company code 77) via the DigitalV3 roster,
 * then returns one `TransactionsAccount` per card with transactions across the month window.
 * Never throws for a "no Amex cards" situation — it just returns `[]` — so a caller can safely
 * append the result to a normal Isracard scrape.
 */
export async function fetchAmexAccountsViaDigital(
  page: Page,
  startMoment: Moment,
  futureMonths: number,
): Promise<TransactionsAccount[]> {
  const allCards = await discoverDigitalV3Cards(page);
  const amexCards = allCards.filter(card => card.companyCode === AMEX_COMPANY_CODE && card.cardStatus === 0);
  debug(`discovered ${amexCards.length} active Amex card(s): ${amexCards.map(c => c.cardSuffix).join(', ') || '(none)'}`);
  if (amexCards.length === 0) {
    return [];
  }

  const months = getAllMonthMoments(startMoment, futureMonths);
  const accounts: TransactionsAccount[] = [];
  for (const card of amexCards) {
    const txns: Transaction[] = [];
    for (const monthMoment of months) {
      await randomDelay(RATE_LIMIT_MS, RATE_LIMIT_MS + 500);
      txns.push(...(await fetchCardMonth(page, card, monthMoment)));
    }
    debug(`Amex card ${card.cardSuffix}: ${txns.length} transaction(s) across ${months.length} month(s)`);
    accounts.push({ accountNumber: card.cardSuffix, companyCode: card.companyCode, txns });
  }
  return accounts;
}

/**
 * Isracard's own cards (issuer company code 11) get their transaction history from the legacy
 * `CardsTransactionsList` API (see `base-isracard-amex.ts`), which has no concept of a
 * not-yet-cleared transaction. This supplements that history with just the signal the legacy API
 * can't provide: transactions still `Pending` per `fetchCardMonth` - either genuinely not yet
 * cleared (`approvals`) or a voucher whose date looks like a stale standing-order placeholder (see
 * `isPlausiblePurchaseDate`). Everything else `fetchCardMonth` returns is deliberately dropped
 * here, since the legacy API already covers it and re-adding it would double-count the same
 * transaction under a fresh `occurrenceIndex`.
 *
 * Only looks at the last month through `futureMonths` ahead - not the full scrape history - since
 * a transaction is only ever missing from the legacy API for its own still-open billing cycle.
 * Returns one `TransactionsAccount` per card (never throws), for the caller to merge into the
 * matching legacy account by `accountNumber`.
 */
export async function fetchUpcomingChargesForIsracardCards(
  page: Page,
  futureMonths: number,
): Promise<TransactionsAccount[]> {
  const allCards = await discoverDigitalV3Cards(page);
  const ownCards = allCards.filter(card => card.companyCode === ISRACARD_COMPANY_CODE && card.cardStatus === 0);
  debug(`discovered ${ownCards.length} active Isracard card(s): ${ownCards.map(c => c.cardSuffix).join(', ') || '(none)'}`);
  if (ownCards.length === 0) {
    return [];
  }

  const months = getAllMonthMoments(moment().subtract(1, 'month'), futureMonths);
  const accounts: TransactionsAccount[] = [];
  for (const card of ownCards) {
    const txns: Transaction[] = [];
    for (const monthMoment of months) {
      await randomDelay(RATE_LIMIT_MS, RATE_LIMIT_MS + 500);
      const monthTxns = await fetchCardMonth(page, card, monthMoment);
      txns.push(...monthTxns.filter(txn => txn.status === TransactionStatuses.Pending));
    }
    debug(`Isracard card ${card.cardSuffix}: ${txns.length} not-yet-cleared transaction(s) across ${months.length} month(s)`);
    accounts.push({ accountNumber: card.cardSuffix, txns });
  }
  return accounts;
}
