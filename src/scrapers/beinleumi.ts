import { type Page } from 'puppeteer';
import { getDebug } from '../helpers/debug';
import { fetchGetWithinPage } from '../helpers/fetch';
import BeinleumiGroupBaseScraper from './base-beinleumi-group';
import { type InvestmentPortfolio, type PortfolioHolding } from './interface';

const PORTFOLIO_URL =
  'https://online.fibi.co.il/wps/myportal/FibiMenu/Online/OnCapitalMarket/OnMyportfolio/cpmDevelope';
const PORTFOLIO_MAIN_INFO_API_PATH = '/bff-cpm3/api/v1/portfolio/main-info';
const PORTFOLIO_SECURITIES_API_PATH = '/bff-cpm3/api/v1/portfolio/securities';
const debug = getDebug('beinleumi');

type BankRecord = Record<string, unknown>;

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textValue(value: unknown, fallback = ''): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  return `${value}`.trim();
}

function asRecords(value: unknown): BankRecord[] {
  if (Array.isArray(value)) return value as BankRecord[];
  return value && typeof value === 'object' ? [value as BankRecord] : [];
}

export function convertBeinleumiPortfolio(
  mainInfo: BankRecord,
  securitiesPayloads: unknown[],
  sourceAccountNumber: string,
): InvestmentPortfolio | null {
  const securities = securitiesPayloads.flatMap(payload => {
    const pagedResult = (payload as { pagedResult?: { results?: unknown } })?.pagedResult;
    return asRecords(pagedResult?.results);
  });
  const totalValue = numberValue(mainInfo.portfolioValue) ?? 0;
  if (totalValue === 0 && securities.length === 0) return null;

  const portfolioCurrency = textValue(mainInfo.currencyISOCode, 'ILS');
  const holdingsById = new Map<string, PortfolioHolding>();
  for (const [index, security] of securities.entries()) {
    const externalId = textValue(
      security.number,
      textValue(security.isin, `${textValue(security.symbol, 'security')}-${index}`),
    );
    if (holdingsById.has(externalId)) continue;
    holdingsById.set(externalId, {
      externalId,
      name: textValue(security.name, textValue(security.symbol, 'Security')),
      symbol: textValue(security.symbol) || undefined,
      quantity: numberValue(security.amount),
      // The dashboard currently renders all values in ILS. The BFF supplies both
      // native holding value and the converted ILS value used by its portfolio total.
      marketValue: numberValue(security.holdingValueInNis ?? security.holdingValue),
      currency: portfolioCurrency,
      percentOfPortfolio: numberValue(security.portfolioPercentage),
      dailyChangePercent: numberValue(security.percentDailyChange),
    });
  }
  const holdings = [...holdingsById.values()];

  return {
    sourceAccountNumber,
    externalId: `${sourceAccountNumber}:securities`,
    currency: portfolioCurrency,
    totalValue,
    availableBalance: numberValue(mainInfo.tradeBalance),
    dailyProfitLoss: numberValue(mainInfo.dailyAmountChange),
    dailyProfitLossPercent: numberValue(mainInfo.dailyPercentageChange),
    holdings,
  };
}

export async function fetchBeinleumiPortfolio(page: Page, sourceAccountNumber: string): Promise<InvestmentPortfolio[]> {
  const mainInfoPromise = page.waitForResponse(response => response.url().includes(PORTFOLIO_MAIN_INFO_API_PATH), {
    timeout: 60000,
  });
  const securitiesPromise = page.waitForResponse(response => response.url().includes(PORTFOLIO_SECURITIES_API_PATH), {
    timeout: 60000,
  });
  await page.goto(PORTFOLIO_URL, { waitUntil: 'domcontentloaded' });
  const [mainInfoResponse, firstSecuritiesResponse] = await Promise.all([mainInfoPromise, securitiesPromise]);
  const mainInfo = (await mainInfoResponse.json()) as BankRecord;
  const firstSecurities = (await firstSecuritiesResponse.json()) as {
    pagedResult?: { pageNumber?: number; totalNumberOfPages?: number };
  };
  const securitiesPayloads: unknown[] = [firstSecurities];
  const totalPages = numberValue(firstSecurities?.pagedResult?.totalNumberOfPages) ?? 1;
  const firstPage = numberValue(firstSecurities?.pagedResult?.pageNumber) ?? 1;
  const securitiesUrl = new URL(firstSecuritiesResponse.url());

  for (let pageNumber = firstPage + 1; pageNumber <= totalPages; pageNumber += 1) {
    securitiesUrl.searchParams.set('pageNumber', String(pageNumber));
    securitiesPayloads.push(await fetchGetWithinPage(page, securitiesUrl.toString()));
  }

  const portfolio = convertBeinleumiPortfolio(mainInfo, securitiesPayloads, sourceAccountNumber);
  return portfolio ? [portfolio] : [];
}

class BeinleumiScraper extends BeinleumiGroupBaseScraper {
  BASE_URL = 'https://online.fibi.co.il';

  LOGIN_URL = `${this.BASE_URL}/MatafLoginService/MatafLoginServlet?bankId=FIBIPORTAL&site=Private&KODSAFA=HE`;

  TRANSACTIONS_URL = `${this.BASE_URL}/wps/myportal/FibiMenu/Online/OnAccountMngment/OnBalanceTrans/PrivateAccountFlow`;

  async fetchData() {
    const baseResult = await super.fetchData();
    if (!baseResult.success) return baseResult;

    const accounts = baseResult.accounts ?? [];
    const selectedAccount = accounts[accounts.length - 1];
    if (!selectedAccount) return { ...baseResult, portfolios: [] };

    let portfolios: InvestmentPortfolio[] | undefined;
    try {
      portfolios = await fetchBeinleumiPortfolio(this.page, selectedAccount.accountNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug(`failed to fetch portfolio: ${message.split(', result:')[0]}`);
      portfolios = undefined;
    }

    return { ...baseResult, portfolios };
  }
}

export default BeinleumiScraper;
