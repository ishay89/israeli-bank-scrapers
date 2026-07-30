import moment from 'moment';
import IsracardAmexBaseScraper from './base-isracard-amex';
import { fetchAmexAccountsViaDigital, fetchUpcomingChargesForIsracardCards } from './isracard-amex-digital';
import { getDebug } from '../helpers/debug';
import { type ScraperOptions, type ScraperScrapingResult } from './interface';
import { type TransactionsAccount } from '../transactions';

const BASE_URL = 'https://digital.isracard.co.il';
const COMPANY_CODE = '11';

const debug = getDebug('isracard');

/**
 * Merges the not-yet-cleared transactions `fetchUpcomingChargesForIsracardCards` found for each
 * card into the matching legacy account by `accountNumber`. A card the roster reported that has no
 * matching legacy account (shouldn't normally happen - the legacy scrape is the source of accounts)
 * is dropped rather than added as a bare, balance-less account.
 */
export function mergeUpcomingCharges(
  accounts: TransactionsAccount[],
  upcomingByAccount: TransactionsAccount[],
): TransactionsAccount[] {
  if (upcomingByAccount.length === 0) {
    return accounts;
  }
  const upcomingByNumber = new Map(upcomingByAccount.map(a => [a.accountNumber, a.txns]));
  return accounts.map(account => {
    const upcomingTxns = upcomingByNumber.get(account.accountNumber);
    if (!upcomingTxns || upcomingTxns.length === 0) {
      return account;
    }
    return { ...account, txns: [...account.txns, ...upcomingTxns] };
  });
}

class IsracardScraper extends IsracardAmexBaseScraper {
  constructor(options: ScraperOptions) {
    super(options, BASE_URL, COMPANY_CODE);
  }

  /**
   * After the standard (legacy-API) Isracard scrape, reuse the same authenticated session to pull
   * any American Express cards via the DigitalV3 web API and append them as extra accounts, tagged
   * with their issuer `companyCode` so the consumer can attribute them to Amex. The Amex step is
   * best-effort: a failure there must not discard the Isracard cards we already fetched.
   *
   * Separately, the legacy API has no concept of a not-yet-cleared transaction (foreign-currency
   * purchases can sit invisible for days while the exchange rate settles - see
   * `fetchUpcomingChargesForIsracardCards`), so also pull that narrow signal via DigitalV3 and
   * merge it into the matching Isracard card by `accountNumber`. Best-effort for the same reason.
   */
  async fetchData(): Promise<ScraperScrapingResult> {
    const base = await super.fetchData();
    if (!base.success) {
      return base;
    }

    let accounts = base.accounts ?? [];

    try {
      const defaultStartMoment = moment().subtract(1, 'years');
      const startDate = this.options.startDate || defaultStartMoment.toDate();
      const startMoment = moment.max(defaultStartMoment, moment(startDate));
      const amexAccounts = await fetchAmexAccountsViaDigital(
        this.page,
        startMoment,
        this.options.futureMonthsToScrape ?? 1,
      );
      if (amexAccounts.length > 0) {
        accounts = [...accounts, ...amexAccounts];
      }
    } catch (e) {
      debug(`Amex-via-DigitalV3 fetch failed, continuing with Isracard cards only: ${(e as Error).message}`);
    }

    try {
      const upcomingByAccount = await fetchUpcomingChargesForIsracardCards(
        this.page,
        this.options.futureMonthsToScrape ?? 1,
      );
      accounts = mergeUpcomingCharges(accounts, upcomingByAccount);
    } catch (e) {
      debug(`Not-yet-cleared Isracard charges fetch failed, continuing without it: ${(e as Error).message}`);
    }

    return { ...base, accounts };
  }
}

export default IsracardScraper;
