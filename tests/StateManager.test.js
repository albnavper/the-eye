/**
 * StateManager Unit Tests
 * Tests the diff logic for detecting new, updated, and unchanged documents
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StateManager } from '../runner/StateManager.js';

describe('StateManager', () => {
    let stateManager;

    beforeEach(() => {
        stateManager = new StateManager({ stateDir: '/tmp/test-state' });
        // Initialize state without filesystem
        stateManager.state = {
            version: 1,
            lastUpdated: null,
            sites: {},
        };
    });

    describe('diff()', () => {
        it('should detect new documents when state is empty', () => {
            const currentDocs = [
                { title: 'Doc 1', url: 'https://example.com/doc1.pdf' },
                { title: 'Doc 2', url: 'https://example.com/doc2.pdf' },
            ];

            const result = stateManager.diff('test-site', currentDocs);

            expect(result.new).toHaveLength(2);
            expect(result.updated).toHaveLength(0);
            expect(result.unchanged).toHaveLength(0);
        });

        it('should detect unchanged documents by URL', () => {
            const existingDocs = [
                { title: 'Doc 1', url: 'https://example.com/doc1.pdf', hash: 'abc123' },
            ];
            stateManager.state.sites['test-site'] = { documents: existingDocs };

            const currentDocs = [
                { title: 'Doc 1', url: 'https://example.com/doc1.pdf', hash: 'abc123' },
            ];

            const result = stateManager.diff('test-site', currentDocs);

            expect(result.new).toHaveLength(0);
            expect(result.updated).toHaveLength(0);
            expect(result.unchanged).toHaveLength(1);
        });

        it('should detect updated documents by hash change', () => {
            const existingDocs = [
                { title: 'Doc 1', url: 'https://example.com/doc1.pdf', hash: 'abc123' },
            ];
            stateManager.state.sites['test-site'] = { documents: existingDocs };

            const currentDocs = [
                { title: 'Doc 1', url: 'https://example.com/doc1.pdf', hash: 'def456' },
            ];

            const result = stateManager.diff('test-site', currentDocs);

            expect(result.new).toHaveLength(0);
            expect(result.updated).toHaveLength(1);
            expect(result.updated[0].reason).toBe('hash_changed');
            expect(result.unchanged).toHaveLength(0);
        });

        it('should detect updated documents by URL change (same title)', () => {
            const existingDocs = [
                { title: 'Important Document', url: 'https://example.com/v1.pdf' },
            ];
            stateManager.state.sites['test-site'] = { documents: existingDocs };

            const currentDocs = [
                { title: 'Important Document', url: 'https://example.com/v2.pdf' },
            ];

            const result = stateManager.diff('test-site', currentDocs);

            expect(result.new).toHaveLength(0);
            expect(result.updated).toHaveLength(1);
            expect(result.updated[0].reason).toBe('url_changed');
        });

        it('should handle mixed scenarios correctly', () => {
            const existingDocs = [
                { title: 'Unchanged', url: 'https://example.com/unchanged.pdf', hash: 'hash1' },
                { title: 'Will Update', url: 'https://example.com/update.pdf', hash: 'old' },
                { title: 'Will Be Removed', url: 'https://example.com/removed.pdf' },
            ];
            stateManager.state.sites['test-site'] = { documents: existingDocs };

            const currentDocs = [
                { title: 'Unchanged', url: 'https://example.com/unchanged.pdf', hash: 'hash1' },
                { title: 'Will Update', url: 'https://example.com/update.pdf', hash: 'new' },
                { title: 'Brand New', url: 'https://example.com/new.pdf' },
            ];

            const result = stateManager.diff('test-site', currentDocs);

            expect(result.unchanged).toHaveLength(1);
            expect(result.updated).toHaveLength(1);
            expect(result.new).toHaveLength(1);
            expect(result.new[0].title).toBe('Brand New');
        });
    });

    describe('getSiteState()', () => {
        it('should create empty state for new site', () => {
            const state = stateManager.getSiteState('new-site');

            expect(state).toBeDefined();
            expect(state.documents).toEqual([]);
            expect(state.lastCheck).toBeNull();
        });

        it('should return existing state', () => {
            stateManager.state.sites['existing'] = {
                lastCheck: '2024-01-01',
                documents: [{ title: 'Test' }],
            };

            const state = stateManager.getSiteState('existing');

            expect(state.documents).toHaveLength(1);
        });
    });

    describe('updateSiteState()', () => {
        it('should update documents with firstSeen timestamp', () => {
            const docs = [
                { title: 'New Doc', url: 'https://example.com/new.pdf' },
            ];

            stateManager.updateSiteState('test-site', docs);
            const state = stateManager.getSiteState('test-site');

            expect(state.documents).toHaveLength(1);
            expect(state.documents[0].firstSeen).toBeDefined();
            expect(state.lastCheck).toBeDefined();
        });
    });

    describe('getSummary()', () => {
        it('should return zero counts for empty state', () => {
            const summary = stateManager.getSummary();

            expect(summary.sites).toBe(0);
            expect(summary.totalDocuments).toBe(0);
        });

        it('should count sites and documents correctly', () => {
            stateManager.state.sites['site1'] = { documents: [{}, {}] };
            stateManager.state.sites['site2'] = { documents: [{}] };

            const summary = stateManager.getSummary();

            expect(summary.sites).toBe(2);
            expect(summary.totalDocuments).toBe(3);
        });
    });
});
