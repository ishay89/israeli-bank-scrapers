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
// `cardSuffix` + `companyCode` (as a numeric string, e.g. "77") + `cardStatus`.
const CARD_LIST_MARKER = 'GetCardList';

export const AMEX_COMPANY_CODE = 77;
const INSTALLMENTS_KEYWORD = 'תשלום';
const ALT_SHEKEL = 'ש"ח';
const RATE_LIMIT_MS = 1500;
const ROSTER_TIMEOUT_MS = 30000;

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

interface DigitalCard {
  cardSuffix: string;
  companyCode: number;
  cardStatus: number;
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

/** Depth-first scan for card-identity objects anywhere in the roster response. Company code and
 *  status may arrive as numbers or numeric strings, so both are coerced. */
function collectCards(node: unknown, out: DigitalCard[] = []): DigitalCard[] {
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

/**
 * Maps one DigitalV3 voucher to the shared `Transaction` shape, mirroring the legacy
 * Isracard/Amex mapping: amounts are negated (outflows are negative), `date` is the purchase
 * date (matching what the bank UI shows), `chargedAmount` is the amount billed this cycle while
 * `originalAmount` is the full deal amount, and installments are parsed from the Hebrew memo.
 */
export function voucherToTransaction(voucher: DigitalVoucher, billingMoment: Moment): Transaction | null {
  if (!voucher.purchaseDate) {
    return null;
  }
  const installments = getInstallments(voucher.moreInfo);
  const billed = voucher.billingAmount ?? voucher.ilsAmount ?? 0;
  const original = voucher.originalAmount ?? billed;
  return {
    type: installments ? TransactionTypes.Installments : TransactionTypes.Normal,
    identifier: voucher.voucherNumber,
    date: moment(voucher.purchaseDate, 'DD/MM/YYYY').toISOString(),
    processedDate: billingMoment.clone().date(1).toISOString(),
    originalAmount: -original,
    originalCurrency: normalizeCurrency(voucher.originalCurrencyIso ?? voucher.originalCurrency),
    chargedAmount: -billed,
    chargedCurrency: 'ILS',
    description: voucher.businessName ?? '',
    memo: voucher.moreInfo?.trim() || '',
    installments,
    status: TransactionStatuses.Completed,
  };
}

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
    data?: { israelAbroadVouchers?: { vouchers?: { israelAbroadVouchersList?: DigitalVoucher[] } } };
  }>(page, TRANSACTIONS_LIST_URL, body, { 'Content-Type': 'application/json' }, true);

  const vouchers = result?.data?.israelAbroadVouchers?.vouchers?.israelAbroadVouchersList ?? [];
  return vouchers
    .map(voucher => voucherToTransaction(voucher, monthMoment))
    .filter((txn): txn is Transaction => txn !== null);
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
  debug('navigating to DigitalV3 transactions page to discover cards');
  const rosterPromise = page
    .waitForResponse(response => response.url().includes(CARD_LIST_MARKER), { timeout: ROSTER_TIMEOUT_MS })
    .catch(() => null);
  await page.goto(TRANSACTIONS_PAGE, { waitUntil: 'load' }).catch(e => debug(`goto warning: ${(e as Error).message}`));

  const rosterResponse = await rosterPromise;
  if (!rosterResponse) {
    debug('did not observe a GetCardList response; no Amex cards discovered');
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
