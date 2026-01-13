/**
 * Navigator - Playwright navigation engine
 * Executes a sequence of navigation steps on a page
 */

export class NavigationError extends Error {
  constructor(message, step, stepIndex, screenshot = null, html = null) {
    super(message);
    this.name = 'NavigationError';
    this.step = step;
    this.stepIndex = stepIndex;
    this.screenshot = screenshot;
    this.html = html;
  }
}

export class Navigator {
  constructor(options = {}) {
    this.defaultTimeout = options.timeout || 30000;
    this.screenshotOnError = options.screenshotOnError ?? true;
  }

  /**
   * Execute navigation steps on a page
   * @param {import('playwright').Page} page - Playwright page
   * @param {Array} steps - Navigation steps to execute
   * @returns {Promise<void>}
   */
  async navigate(page, steps) {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const maxRetries = step.retries ?? 1; // Default: 1 retry (2 total attempts)
      let lastError = null;
      let success = false;

      for (let attempt = 0; attempt <= maxRetries && !success; attempt++) {
        try {
          await this.executeStep(page, step);
          console.log(`  ✓ Step ${i + 1}/${steps.length}: ${step.action} ${step.selector || ''}`);
          success = true;
        } catch (error) {
          lastError = error;

          if (attempt < maxRetries) {
            console.log(`  ⚡ Step ${i + 1} attempt ${attempt + 1} failed, retrying...`);
            await page.waitForTimeout(1000 * (attempt + 1)); // Exponential backoff
          }
        }
      }

      if (!success) {
        // Capture diagnostic info
        let screenshot = null;
        let html = null;

        if (this.screenshotOnError) {
          try {
            screenshot = await page.screenshot({ fullPage: true });
            html = await page.content();
          } catch (captureError) {
            console.error('Failed to capture diagnostics:', captureError.message);
          }
        }

        // If step is optional, log and continue
        if (step.optional) {
          console.log(`  ⚠ Step ${i + 1}/${steps.length} (optional) failed: ${lastError.message}`);
          continue;
        }

        throw new NavigationError(
          `Navigation step failed: ${step.action} - ${lastError.message}`,
          step,
          i,
          screenshot,
          html
        );
      }
    }
  }

  /**
   * Execute a single navigation step
   * @param {import('playwright').Page} page 
   * @param {Object} step 
   */
  async executeStep(page, step) {
    const timeout = step.timeout || this.defaultTimeout;

    switch (step.action) {
      case 'click':
        await page.click(step.selector, { timeout });
        break;

      case 'waitForSelector':
        await page.waitForSelector(step.selector, {
          state: step.state || 'visible',
          timeout
        });
        break;

      case 'fill':
        await page.fill(step.selector, step.value, { timeout });
        break;

      case 'type':
        // Type character by character (triggers input events for autocomplete)
        await page.click(step.selector, { timeout });
        await page.type(step.selector, step.value, { delay: step.delay || 50 });
        break;

      case 'press':
        if (step.selector) {
          await page.press(step.selector, step.key, { timeout });
        } else {
          await page.keyboard.press(step.key);
        }
        break;

      case 'scroll':
        if (step.selector) {
          await page.locator(step.selector).scrollIntoViewIfNeeded({ timeout });
        } else {
          await page.evaluate((distance) => {
            window.scrollBy(0, distance || 500);
          }, step.distance);
        }
        break;

      case 'wait':
        await page.waitForTimeout(step.duration || step.value || 1000);
        break;

      case 'wait_ajax':
        // Wait for network to be idle (no pending requests for 500ms)
        await page.waitForLoadState('networkidle', { timeout });
        break;

      case 'waitForNavigation':
        await page.waitForNavigation({
          waitUntil: step.waitUntil || 'load',
          timeout
        });
        break;

      case 'select':
        await page.selectOption(step.selector, step.value, { timeout });
        break;

      case 'hover':
        await page.hover(step.selector, { timeout });
        break;

      case 'check':
        await page.check(step.selector, { timeout });
        break;

      case 'uncheck':
        await page.uncheck(step.selector, { timeout });
        break;

      case 'evaluate':
        // Execute custom JavaScript
        await page.evaluate(step.script);
        break;

      case 'goto':
        // Navigate to a URL (useful after extracting href via evaluate)
        await page.goto(step.url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout });
        break;

      case 'authenticate':
        // Fill login form and submit
        // Supports environment variable substitution with ${VAR_NAME} syntax
        const resolveEnvVar = (val) => {
          if (typeof val === 'string' && val.startsWith('${') && val.endsWith('}')) {
            const envName = val.slice(2, -1);
            const envVal = process.env[envName];
            if (!envVal) {
              throw new Error(`Environment variable ${envName} is not set`);
            }
            return envVal;
          }
          return val;
        };

        const user = resolveEnvVar(step.user);
        const pass = resolveEnvVar(step.pass);

        // Fill username using evaluate to trigger Vue reactivity
        await page.evaluate(({ selector, value }) => {
          const el = document.querySelector(selector);
          if (el) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, { selector: step.userSelector, value: user });

        // Fill password using evaluate to trigger Vue reactivity
        await page.evaluate(({ selector, value }) => {
          const el = document.querySelector(selector);
          if (el) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, { selector: step.passSelector, value: pass });

        // Click submit button
        await page.click(step.submitSelector, { timeout });

        // Wait for navigation/network to settle
        await page.waitForLoadState('networkidle', { timeout });
        break;

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }
}

export default Navigator;
