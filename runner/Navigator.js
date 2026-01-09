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
      try {
        await this.executeStep(page, step);
        console.log(`  ✓ Step ${i + 1}/${steps.length}: ${step.action} ${step.selector || ''}`);
      } catch (error) {
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
          console.log(`  ⚠ Step ${i + 1}/${steps.length} (optional) failed: ${error.message}`);
          continue;
        }

        throw new NavigationError(
          `Navigation step failed: ${step.action} - ${error.message}`,
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

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }
}

export default Navigator;
