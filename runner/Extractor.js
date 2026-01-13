/**
 * Extractor - Document list extraction from pages
 * Extracts document information based on CSS selectors configuration
 */

export class ExtractionError extends Error {
    constructor(message, selector = null) {
        super(message);
        this.name = 'ExtractionError';
        this.selector = selector;
    }
}

export class Extractor {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || '';
    }

    /**
     * Extract documents from a page based on extraction config
     * @param {import('playwright').Page} page - Playwright page
     * @param {Object} config - Extraction configuration
     * @returns {Promise<Array<{title: string, url: string, date?: string}>>}
     */
    async extract(page, config) {
        const { listSelector, fields, filterPatterns } = config;

        // Find all document items
        const items = await page.$$(listSelector);

        if (items.length === 0) {
            console.log(`  ⚠ No items found with selector: ${listSelector}`);
            return [];
        }

        console.log(`  Found ${items.length} document items`);

        let documents = [];

        for (const item of items) {
            try {
                const doc = await this.extractDocument(item, fields, page);
                if (doc && (doc.url || doc.title)) {
                    documents.push(doc);
                }
            } catch (error) {
                console.log(`  ⚠ Failed to extract document: ${error.message}`);
            }
        }

        console.log(`  Extracted ${documents.length} valid documents`);

        // Apply post-extraction filtering if configured
        if (filterPatterns) {
            documents = this.applyFilters(documents, filterPatterns);
        }

        return documents;
    }

    /**
     * Apply filters to extracted documents
     * @param {Array} documents - Extracted documents
     * @param {Object} filterConfig - Filter configuration
     * @returns {Array} Filtered documents
     */
    applyFilters(documents, filterConfig) {
        const { field, patterns, mode = 'include' } = filterConfig;

        if (!field || !patterns || !patterns.length) {
            return documents;
        }

        console.log(`  🔍 Filtering by ${field}: ${mode} patterns [${patterns.join(', ')}]`);

        const filtered = documents.filter(doc => {
            const fieldValue = (doc[field] || '').toLowerCase();
            const matchesPattern = patterns.some(p => fieldValue.includes(p.toLowerCase()));

            // 'include' mode: keep docs that match
            // 'exclude' mode: keep docs that don't match
            return mode === 'include' ? matchesPattern : !matchesPattern;
        });

        console.log(`  🔍 Filtered: ${filtered.length}/${documents.length} documents match criteria`);
        return filtered;
    }

    /**
     * Extract a single document from an element
     * @param {import('playwright').ElementHandle} element 
     * @param {Object} fields 
     * @param {import('playwright').Page} page
     * @returns {Promise<Object>}
     */
    async extractDocument(element, fields, page) {
        const doc = {};

        for (const [fieldName, fieldConfig] of Object.entries(fields)) {
            try {
                const value = await this.extractField(element, fieldConfig, page);
                if (value) {
                    doc[fieldName] = value;
                }
            } catch (error) {
                if (!fieldConfig.optional) {
                    throw error;
                }
            }
        }

        // Normalize the document
        return this.normalizeDocument(doc, page);
    }

    /**
     * Extract a single field from an element
     * @param {import('playwright').ElementHandle} element 
     * @param {Object|string} config - Field config or selector string
     * @param {import('playwright').Page} page
     * @returns {Promise<string|null>}
     */
    async extractField(element, config, page) {
        // Support simple string selector
        if (typeof config === 'string') {
            config = { selector: config, attribute: null };
        }

        const { selector, attribute, property, regex, urlTemplate } = config;

        // Find the target element
        const target = selector === '.' || selector === ''
            ? element
            : await element.$(selector);

        if (!target) {
            if (config.optional) return null;
            throw new ExtractionError(`Field element not found`, selector);
        }

        // Extract value
        let value;

        // Support for JavaScript properties (for web components like wec-download-file)
        if (property) {
            value = await target.evaluate((el, prop) => el[prop], property);
        } else if (attribute === 'href' || attribute === 'src') {
            // Get absolute URL
            value = await target.evaluate((el, attr) => {
                const val = el.getAttribute(attr);
                if (!val) return null;
                // Convert relative URL to absolute
                return new URL(val, document.baseURI).href;
            }, attribute);
        } else if (attribute) {
            value = await target.getAttribute(attribute);
        } else {
            value = await target.textContent();
        }

        // Apply regex extraction if configured
        if (value && regex) {
            const match = value.match(new RegExp(regex));
            if (match && match[1]) {
                value = match[1];
            } else {
                // Regex didn't match, return null if no default
                if (config.optional) return null;
                throw new ExtractionError(`Regex did not match: ${regex}`, selector);
            }
        }

        // Apply URL template if configured
        if (value && urlTemplate) {
            value = urlTemplate.replace('{value}', value);
        }

        return value ? value.trim() : null;
    }

    /**
     * Normalize document data (clean URLs, trim text, etc.)
     * @param {Object} doc 
     * @param {import('playwright').Page} page
     * @returns {Object}
     */
    normalizeDocument(doc, page) {
        if (!doc.url) return null;

        // Clean title
        if (doc.title) {
            doc.title = doc.title
                .replace(/\s+/g, ' ')
                .trim();
        }

        // Normalize URL - remove cache-busting params
        try {
            const url = new URL(doc.url);
            // Remove common cache parameters
            ['_', 'v', 'cache', 'timestamp', 't', 'rand'].forEach(param => {
                url.searchParams.delete(param);
            });
            doc.url = url.href;
        } catch (e) {
            // URL parsing failed, keep original
        }

        // Clean date
        if (doc.date) {
            doc.date = doc.date.trim();
        }

        // Create a normalized ID for comparison
        doc.id = this.createDocId(doc);

        return doc;
    }

    /**
     * Create a unique document ID for comparison
     * @param {Object} doc 
     * @returns {string}
     */
    createDocId(doc) {
        // Combine normalized title and URL for unique identification
        const titlePart = (doc.title || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
        const urlPart = doc.url
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/[^a-z0-9]/g, '');

        return `${titlePart}::${urlPart}`.substring(0, 200);
    }

    /**
     * Resolve deep links - navigate to intermediate pages to find real download URLs
     * @param {import('playwright').Page} page - Playwright page
     * @param {Array} documents - Documents with intermediate URLs
     * @param {Object} deepSearchConfig - Deep search configuration
     * @returns {Promise<Array>} Documents with resolved final URLs
     */
    async resolveDeepLinks(page, documents, deepSearchConfig) {
        if (!deepSearchConfig?.enabled) {
            return documents;
        }

        const { selector, attribute = 'href' } = deepSearchConfig;
        console.log(`  🔍 Deep Search: Resolving ${documents.length} intermediate URLs...`);

        const resolvedDocs = [];

        for (const doc of documents) {
            try {
                console.log(`    → Navigating to: ${doc.url}`);

                // Navigate to intermediate page
                await page.goto(doc.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

                // Wait for the target element
                await page.waitForSelector(selector, { timeout: 10000 });

                // Extract the real URL
                const realUrl = await page.$eval(selector, (el, attr) => {
                    const val = el.getAttribute(attr);
                    if (!val) return null;
                    return new URL(val, document.baseURI).href;
                }, attribute);

                if (realUrl) {
                    console.log(`    ✓ Found real URL: ${realUrl.substring(0, 60)}...`);
                    resolvedDocs.push({
                        ...doc,
                        intermediateUrl: doc.url, // Keep original for reference
                        url: realUrl              // Replace with final URL
                    });
                } else {
                    console.log(`    ⚠ No URL found with selector: ${selector}`);
                    resolvedDocs.push(doc); // Keep original
                }
            } catch (error) {
                console.log(`    ⚠ Deep search failed for ${doc.title}: ${error.message}`);
                resolvedDocs.push(doc); // Keep original on error
            }
        }

        console.log(`  🔍 Deep Search complete: ${resolvedDocs.filter(d => d.intermediateUrl).length} URLs resolved`);
        return resolvedDocs;
    }
}

export default Extractor;
