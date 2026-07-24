import moment from 'moment';
import IsracardAmexBaseScraper from './base-isracard-amex';
import { fetchAmexAccountsViaDigital } from './isracard-amex-digital';
import { getDebug } from '../helpers/debug';
import { type ScraperOptions, type ScraperScrapingResult } from './interface';

const BASE_URL = 'https://digital.isracard.co.il';
const COMPANY_CODE = '11';

const debug = getDebug('isracard');

class IsracardScraper extends IsracardAmexBaseScraper {
  constructor(options: ScraperOptions) {
    super(options, BASE_URL, COMPANY_CODE);
  }

  /**
   * After the standard (legacy-API) Isracard scrape, reuse the same authenticated session to pull
   * any American Express cards via the DigitalV3 web API and append them as extra accounts, tagged
   * with their issuer `companyCode` so the consumer can attribute them to Amex. The Amex step is
   * best-effort: a failure there must not discard the Isracard cards we already fetched.
   */
  async fetchData(): Promise<ScraperScrapingResult> {
    const base = await super.fetchData();
    if (!base.success) {
      return base;
    }

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
        return { ...base, accounts: [...(base.accounts ?? []), ...amexAccounts] };
      }
    } catch (e) {
      debug(`Amex-via-DigitalV3 fetch failed, continuing with Isracard cards only: ${(e as Error).message}`);
    }
    return base;
  }
}

export default IsracardScraper;
