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
        const { listSelector, fields } = config;

        // Find all document items
        const items = await page.$$(listSelector);

        if (items.length === 0) {
            console.log(`  ⚠ No items found with selector: ${listSelector}`);
            return [];
        }

        console.log(`  Found ${items.length} document items`);

        const documents = [];

        for (const item of items) {
            try {
                const doc = await this.extractDocument(item, fields, page);
                if (doc && doc.url) {
                    documents.push(doc);
                }
            } catch (error) {
                console.log(`  ⚠ Failed to extract document: ${error.message}`);
            }
        }

        console.log(`  Extracted ${documents.length} valid documents`);
        return documents;
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

        const { selector, attribute } = config;

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
        if (attribute === 'href' || attribute === 'src') {
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
}

export default Extractor;
