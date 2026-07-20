import { type Page } from 'puppeteer';
import { getPossibleLoginResults, waitForLoginReadiness, waitForPostLogin } from './base-beinleumi-group';
import { LoginResults } from './base-scraper-with-browser';

const CHANGE_PASSWORD_FORM_SELECTOR = '#ChangePswform';

/**
 * Fake puppeteer Page for the password-expired state: the change-password form
 * is visible, while none of the regular post-login elements ever appear.
 */
function createChangePasswordPage(): Page {
  return {
    waitForSelector: (selector: string) => {
      if (selector === CHANGE_PASSWORD_FORM_SELECTOR) {
        return Promise.resolve({});
      }
      return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Waiting for selector \`${selector}\` failed`)), 20);
      });
    },
    $eval: (selector: string) => {
      if (selector === CHANGE_PASSWORD_FORM_SELECTOR) {
        return Promise.resolve(true);
      }
      return Promise.reject(new Error(`failed to find element matching selector "${selector}"`));
    },
  } as unknown as Page;
}

describe('Beinleumi group base scraper', () => {
  test('login readiness resolves when the real login button is visible', async () => {
    const page = {
      waitForSelector: (selector: string) =>
        selector === '#continueBtn' ? Promise.resolve({}) : Promise.reject(new Error(`unexpected ${selector}`)),
      waitForFunction: () => new Promise(() => undefined),
    } as unknown as Page;

    await expect(waitForLoginReadiness(page)).resolves.not.toThrow();
  });

  test('login readiness reports a Radware challenge instead of a selector timeout', async () => {
    const page = {
      waitForSelector: () => new Promise(() => undefined),
      waitForFunction: () => Promise.resolve({}),
      evaluate: () =>
        Promise.resolve({
          title: 'Radware Bot Manager Captcha',
          hostname: 'validate.perfdrive.com',
          pathname: '/challenge/',
        }),
    } as unknown as Page;

    await expect(waitForLoginReadiness(page)).rejects.toThrow('Beinleumi login blocked by Radware Bot Manager');
  });

  test('waitForPostLogin resolves when the change-password form is shown', async () => {
    await expect(waitForPostLogin(createChangePasswordPage())).resolves.not.toThrow();
  });

  test('possible login results classify a visible change-password form as ChangePassword', async () => {
    const conditions = getPossibleLoginResults()[LoginResults.ChangePassword];
    expect(conditions).toBeDefined();
    expect(conditions).toHaveLength(1);

    const [condition] = conditions!;
    expect(typeof condition).toBe('function');
    if (typeof condition !== 'function') return;

    await expect(condition({ page: createChangePasswordPage() })).resolves.toBe(true);
  });

  test('change-password condition is false when the form is not on the page', async () => {
    const conditions = getPossibleLoginResults()[LoginResults.ChangePassword];
    const [condition] = conditions ?? [];
    if (typeof condition !== 'function') {
      throw new Error('expected a function condition for ChangePassword');
    }

    const pageWithoutForm = {
      $eval: () => Promise.reject(new Error('failed to find element matching selector')),
    } as unknown as Page;

    await expect(condition({ page: pageWithoutForm })).resolves.toBe(false);
  });
});
