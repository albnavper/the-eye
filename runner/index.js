#!/usr/bin/env node
/**
 * The Eye - Government Document Monitor
 * Main orchestrator for navigation, extraction, and notification
 */

import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { Navigator, NavigationError } from './Navigator.js';
import { Extractor } from './Extractor.js';
import { Downloader, DownloadError } from './Downloader.js';
import { StateManager } from './StateManager.js';
import { TelegramNotifier } from './TelegramNotifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

// CLI Arguments parsing
function parseArgs() {
    const args = {
        dryRun: false,
        notify: false,
        siteId: null,
        configJson: null,
        configFile: null,
        help: false,
    };

    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];

        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--notify') args.notify = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (arg.startsWith('--site-id=')) args.siteId = arg.split('=')[1];
        else if (arg.startsWith('--config-json=')) args.configJson = arg.split('=').slice(1).join('=');
        else if (arg.startsWith('--config-file=')) args.configFile = arg.split('=')[1];
    }

    return args;
}

function printHelp() {
    console.log(`
The Eye - Government Document Monitor

Usage: node runner/index.js [options]

Options:
  --dry-run           Run without saving state or sending notifications
                      (unless --notify is also specified)
  --notify            Send Telegram notifications even in dry-run mode
  --site-id=ID        Process only the specified site
  --config-json=JSON  Use inline JSON config for a single site (for testing)
  --config-file=PATH  Use alternative config file (default: config/sites.json)
  --help, -h          Show this help message

Examples:
  # Normal run (process all enabled sites)
  node runner/index.js

  # Dry run for testing (no state changes, no notifications)
  node runner/index.js --dry-run

  # Dry run with notifications (for testing Telegram)
  node runner/index.js --dry-run --notify

  # Test a single site
  node runner/index.js --dry-run --site-id=boe-ayudas

  # Test with inline config
  node runner/index.js --dry-run --config-json='{"id":"test","name":"Test","url":"https://example.com","steps":[],"extraction":{"listSelector":"a","fields":{"title":".","url":"@href"}}}'
`);
}

// Load configuration
async function loadConfig(args) {
    // Inline JSON config (for dry-run testing)
    if (args.configJson) {
        const site = JSON.parse(args.configJson);
        return {
            sites: [{ ...site, enabled: true }],
            telegram: {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
            },
            defaults: { timeout: 30000, retries: 2 },
        };
    }

    // Load from file
    const configPath = args.configFile || path.join(ROOT_DIR, 'config', 'sites.json');

    try {
        const configData = await fs.readFile(configPath, 'utf-8');
        return JSON.parse(configData);
    } catch (error) {
        // Try example file as fallback
        const examplePath = path.join(ROOT_DIR, 'config', 'sites.example.json');
        console.log(`Config not found at ${configPath}, trying ${examplePath}`);

        try {
            const exampleData = await fs.readFile(examplePath, 'utf-8');
            return JSON.parse(exampleData);
        } catch {
            throw new Error(`No configuration found. Create config/sites.json or use --config-json`);
        }
    }
}

// Exponential backoff retry
async function withRetry(fn, retries = 2, baseDelay = 1000) {
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                const delay = baseDelay * Math.pow(2, attempt);
                console.log(`  Retry ${attempt + 1}/${retries} in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    throw lastError;
}

// Create a fingerprint for error deduplication
function createErrorFingerprint(error, stepInfo = null) {
    const parts = [
        error.name || 'Error',
        error.message,
        stepInfo?.action || '',
        stepInfo?.selector || '',
    ];
    // Simple hash: join parts and create a short hash
    const str = parts.join('|');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
}

// Process a single site
async function processSite(site, browser, stateManager, notifier, args) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing: ${site.name} (${site.id})`);
    console.log(`URL: ${site.url}`);
    console.log(`${'='.repeat(60)}`);

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    const navigator = new Navigator({ timeout: site.timeout || 30000 });
    const extractor = new Extractor({ baseUrl: site.url });
    const downloader = new Downloader({
        downloadDir: path.join(ROOT_DIR, 'downloads'),
        timeout: site.downloadTimeout || 30000,
    });

    try {
        // Step 1: Navigate to page
        console.log('\n[1/6] Navigating to page...');
        await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Step 2: Execute navigation steps
        if (site.steps && site.steps.length > 0) {
            console.log(`\n[2/6] Executing ${site.steps.length} navigation steps...`);
            await navigator.navigate(page, site.steps);
        } else {
            console.log('\n[2/6] No navigation steps configured');
        }

        // Step 3: Extract documents
        console.log('\n[3/6] Extracting documents...');
        let documents = await extractor.extract(page, site.extraction);

        if (documents.length === 0) {
            console.log('  No documents found');
            // Debug: save screenshot to see what the page looks like
            const debugPath = path.join(ROOT_DIR, 'downloads', `debug-${site.id}-${Date.now()}.png`);
            await page.screenshot({ path: debugPath, fullPage: true });
            console.log(`  Debug screenshot saved: ${debugPath}`);
            await context.close();
            return { success: true, documents: 0, new: 0, updated: 0 };
        }

        // Step 4: Deep Search (resolve intermediate URLs if configured)
        if (site.extraction.deepSearch?.enabled) {
            console.log('\n[4/6] Resolving deep links...');
            documents = await extractor.resolveDeepLinks(page, documents, site.extraction.deepSearch);
        } else {
            console.log('\n[4/6] Deep search not configured, skipping...');
        }

        // Step 5: Compare with previous state
        console.log('\n[5/6] Comparing with previous state...');
        const diff = stateManager.diff(site.id, documents);
        console.log(`  New: ${diff.new.length}, Updated: ${diff.updated.length}, Unchanged: ${diff.unchanged.length}`);

        // Step 6: Process changes
        console.log('\n[6/6] Processing changes...');

        const shouldNotify = !args.dryRun || args.notify;
        let processed = 0;

        // Process new documents
        for (const doc of diff.new) {
            console.log(`  📄 NEW: ${doc.title || doc.url}`);

            try {
                // Download file
                const download = await withRetry(
                    () => downloader.download(page, doc.url),
                    site.retries || 2
                );

                doc.hash = download.hash;

                // Send to Telegram
                if (shouldNotify) {
                    await notifier.notifyNewDocument(site.name, doc, download.path);
                    console.log(`    ✓ Sent to Telegram`);
                }

                // Cleanup downloaded file
                await fs.unlink(download.path).catch(() => { });
                processed++;

            } catch (error) {
                console.log(`    ✗ Download failed: ${error.message}`);

                if (shouldNotify) {
                    // Still notify about the new document, without file
                    await notifier.notifyNewDocument(site.name, doc, null);
                }
            }
        }

        // Process updated documents
        for (const { doc, previousDoc, reason } of diff.updated) {
            console.log(`  🔄 UPDATED: ${doc.title || doc.url} (${reason})`);

            try {
                // Download file
                const download = await withRetry(
                    () => downloader.download(page, doc.url),
                    site.retries || 2
                );

                doc.hash = download.hash;

                // Send to Telegram
                if (shouldNotify) {
                    await notifier.notifyUpdatedDocument(site.name, doc, download.path, reason);
                    console.log(`    ✓ Sent to Telegram`);
                }

                // Cleanup
                await fs.unlink(download.path).catch(() => { });
                processed++;

            } catch (error) {
                console.log(`    ✗ Download failed: ${error.message}`);

                if (shouldNotify) {
                    await notifier.notifyUpdatedDocument(site.name, doc, null, reason);
                }
            }
        }

        // Update state (only if not dry-run)
        if (!args.dryRun) {
            // Merge hashes into documents for state update
            const allDocs = [
                ...diff.new,
                ...diff.updated.map(u => u.doc),
                ...diff.unchanged,
            ];
            stateManager.updateSiteState(site.id, allDocs);
        }

        // Clear any previous error state since this run succeeded
        stateManager.clearLastError(site.id);

        await context.close();

        return {
            success: true,
            documents: documents.length,
            new: diff.new.length,
            updated: diff.updated.length,
            processed,
        };

    } catch (error) {
        console.error(`\n❌ Error processing ${site.name}: ${error.message}`);

        // Capture diagnostics
        let screenshot = null;
        try {
            screenshot = await page.screenshot({ fullPage: true });
        } catch { }

        // Generate error fingerprint for deduplication
        const errorFingerprint = createErrorFingerprint(error, error.step);
        const lastError = stateManager.getLastError(site.id);
        const isDuplicate = lastError?.fingerprint === errorFingerprint;

        // Store the error (even if duplicate, to update count)
        stateManager.setLastError(site.id, {
            fingerprint: errorFingerprint,
            message: error.message,
            step: error.step,
        });

        // Only send notification if error is new/different
        const shouldNotify = !args.dryRun || args.notify;
        if (shouldNotify && !isDuplicate) {
            const currentError = stateManager.getLastError(site.id);
            await notifier.notifyError(site.name, error, {
                url: site.url,
                siteId: site.id,
                step: error.step,
                stepIndex: error.stepIndex,
                totalSteps: site.steps?.length,
                screenshot,
                retryCount: site.retries || 2,
                consecutiveCount: currentError?.consecutiveCount,
            });
        } else if (isDuplicate) {
            const count = stateManager.getLastError(site.id)?.consecutiveCount || 1;
            console.log(`  ⏭️  Error duplicado (${count}x consecutivo), notificación omitida`);
        }

        await context.close();

        return {
            success: false,
            error: error.message,
        };
    }
}

// Main entry point
async function main() {
    const args = parseArgs();

    if (args.help) {
        printHelp();
        process.exit(0);
    }

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║              THE EYE - Document Monitor                    ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log(`\nMode: ${args.dryRun ? 'DRY RUN' : 'PRODUCTION'}`);
    console.log(`Notifications: ${(!args.dryRun || args.notify) ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Time: ${new Date().toISOString()}`);

    // Load configuration
    const config = await loadConfig(args);
    console.log(`\nLoaded ${config.sites.length} site(s) from config`);

    // Filter sites
    let sites = config.sites.filter(s => s.enabled !== false);

    if (args.siteId) {
        sites = sites.filter(s => s.id === args.siteId);
        if (sites.length === 0) {
            console.error(`Site not found: ${args.siteId}`);
            process.exit(1);
        }
    }

    console.log(`Processing ${sites.length} enabled site(s)`);

    // Initialize components
    const stateManager = new StateManager({ stateDir: path.join(ROOT_DIR, 'state') });
    await stateManager.load();
    console.log(`State: ${stateManager.getSummary().totalDocuments} documents tracked`);

    const notifier = new TelegramNotifier({
        botToken: config.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN,
        chatId: config.telegram?.chatId || process.env.TELEGRAM_CHAT_ID,
    });

    if (!notifier.isConfigured()) {
        console.log('\n⚠️  Telegram not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)');
    }

    // Launch browser
    const browser = await chromium.launch({
        headless: true,
    });

    // Process each site
    const results = [];

    for (const site of sites) {
        const result = await processSite(site, browser, stateManager, notifier, args);
        results.push({ site: site.id, ...result });

        // Small delay between sites
        await new Promise(r => setTimeout(r, 1000));
    }

    // Close browser
    await browser.close();

    // Save state (only if not dry-run)
    if (!args.dryRun) {
        await stateManager.save();
        console.log('\n✓ State saved');
    }

    // Cleanup old downloads
    const downloader = new Downloader({ downloadDir: path.join(ROOT_DIR, 'downloads') });
    await downloader.cleanup();

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    for (const result of results) {
        const status = result.success ? '✓' : '✗';
        const details = result.success
            ? `${result.documents} docs, ${result.new} new, ${result.updated} updated`
            : result.error;
        console.log(`${status} ${result.site}: ${details}`);
    }

    console.log(`\n${successful.length}/${results.length} sites processed successfully`);

    // Only fail if ALL sites failed (partial success is acceptable)
    if (failed.length === results.length && results.length > 0) {
        console.error('\n❌ All sites failed!');
        process.exit(1);
    } else if (failed.length > 0) {
        console.log(`\n⚠️  ${failed.length} site(s) had errors (partial success)`);
    }

    process.exit(0);
}

// Run
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
