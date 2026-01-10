/**
 * StateManager - State persistence and diff detection
 * Manages document state between runs and detects changes
 */

import { promises as fs } from 'fs';
import path from 'path';

export class StateManager {
    constructor(options = {}) {
        this.stateDir = options.stateDir || './state';
        this.stateFile = path.join(this.stateDir, 'state.json');
        this.state = null;
    }

    /**
     * Load state from file
     * @returns {Promise<Object>}
     */
    async load() {
        try {
            await fs.mkdir(this.stateDir, { recursive: true });
            const data = await fs.readFile(this.stateFile, 'utf-8');
            this.state = JSON.parse(data);
        } catch (error) {
            // Initialize empty state
            this.state = {
                version: 1,
                lastUpdated: null,
                sites: {},
            };
        }
        return this.state;
    }

    /**
     * Save state to file
     * @returns {Promise<void>}
     */
    async save() {
        if (!this.state) {
            throw new Error('State not loaded');
        }

        this.state.lastUpdated = new Date().toISOString();

        await fs.mkdir(this.stateDir, { recursive: true });
        await fs.writeFile(
            this.stateFile,
            JSON.stringify(this.state, null, 2),
            'utf-8'
        );
    }

    /**
     * Get state for a specific site
     * @param {string} siteId 
     * @returns {Object}
     */
    getSiteState(siteId) {
        if (!this.state) {
            throw new Error('State not loaded');
        }

        if (!this.state.sites[siteId]) {
            this.state.sites[siteId] = {
                lastCheck: null,
                documents: [],
            };
        }

        return this.state.sites[siteId];
    }

    /**
     * Compare current documents with previous state and detect changes
     * @param {string} siteId 
     * @param {Array} currentDocs - Current document list
     * @returns {{new: Array, updated: Array, unchanged: Array}}
     */
    diff(siteId, currentDocs) {
        const siteState = this.getSiteState(siteId);
        const previousDocs = siteState.documents || [];

        // Create lookup maps
        const previousByUrl = new Map();
        const previousByTitle = new Map();

        for (const doc of previousDocs) {
            previousByUrl.set(doc.url, doc);
            if (doc.title) {
                previousByTitle.set(doc.title.toLowerCase(), doc);
            }
        }

        const newDocs = [];
        const updatedDocs = [];
        const unchangedDocs = [];

        for (const doc of currentDocs) {
            // Check by URL first
            const prevByUrl = previousByUrl.get(doc.url);

            if (prevByUrl) {
                // URL exists - check if hash changed
                if (doc.hash && prevByUrl.hash && doc.hash !== prevByUrl.hash) {
                    updatedDocs.push({ doc, previousDoc: prevByUrl, reason: 'hash_changed' });
                } else {
                    unchangedDocs.push(doc);
                }
                continue;
            }

            // Check by title (same title but different URL = likely updated)
            const titleKey = doc.title?.toLowerCase();
            const prevByTitle = titleKey ? previousByTitle.get(titleKey) : null;

            if (prevByTitle && prevByTitle.url !== doc.url) {
                // Same title, different URL = updated document
                updatedDocs.push({ doc, previousDoc: prevByTitle, reason: 'url_changed' });
            } else {
                // Completely new document
                newDocs.push(doc);
            }
        }

        return {
            new: newDocs,
            updated: updatedDocs,
            unchanged: unchangedDocs,
        };
    }

    /**
     * Update site state with new documents
     * @param {string} siteId 
     * @param {Array} documents 
     */
    updateSiteState(siteId, documents) {
        const siteState = this.getSiteState(siteId);
        siteState.lastCheck = new Date().toISOString();
        siteState.documents = documents.map(doc => ({
            title: doc.title,
            url: doc.url,
            hash: doc.hash,
            date: doc.date,
            firstSeen: doc.firstSeen || new Date().toISOString(),
        }));
    }

    /**
     * Mark a document as processed (hash updated after download)
     * @param {string} siteId 
     * @param {string} url 
     * @param {string} hash 
     */
    updateDocumentHash(siteId, url, hash) {
        const siteState = this.getSiteState(siteId);
        const doc = siteState.documents.find(d => d.url === url);
        if (doc) {
            doc.hash = hash;
            doc.lastUpdated = new Date().toISOString();
        }
    }

    /**
     * Get the last error fingerprint for a site
     * @param {string} siteId 
     * @returns {Object|null} Error info with fingerprint, message, timestamp
     */
    getLastError(siteId) {
        const siteState = this.getSiteState(siteId);
        return siteState.lastError || null;
    }

    /**
     * Set the last error for a site (to detect duplicates)
     * @param {string} siteId 
     * @param {Object} errorInfo - Error details including fingerprint
     */
    setLastError(siteId, errorInfo) {
        const siteState = this.getSiteState(siteId);
        siteState.lastError = {
            fingerprint: errorInfo.fingerprint,
            message: errorInfo.message,
            step: errorInfo.step,
            timestamp: new Date().toISOString(),
            consecutiveCount: (siteState.lastError?.fingerprint === errorInfo.fingerprint)
                ? (siteState.lastError.consecutiveCount || 1) + 1
                : 1,
        };
    }

    /**
     * Clear the last error for a site (called when site succeeds)
     * @param {string} siteId 
     */
    clearLastError(siteId) {
        const siteState = this.getSiteState(siteId);
        if (siteState.lastError) {
            siteState.lastError = null;
        }
    }

    /**
     * Get summary of state for logging
     * @returns {Object}
     */
    getSummary() {
        if (!this.state) return { sites: 0, totalDocuments: 0 };

        const sites = Object.keys(this.state.sites).length;
        const totalDocuments = Object.values(this.state.sites)
            .reduce((sum, site) => sum + (site.documents?.length || 0), 0);

        return {
            sites,
            totalDocuments,
            lastUpdated: this.state.lastUpdated,
        };
    }
}

export default StateManager;
