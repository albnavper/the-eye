/**
 * Downloader - File download with validation
 * Downloads files via Playwright and validates content type using magic numbers
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

// Magic numbers for common document types
const MAGIC_NUMBERS = {
    pdf: { bytes: [0x25, 0x50, 0x44, 0x46], description: 'PDF document' },
    zip: { bytes: [0x50, 0x4B, 0x03, 0x04], description: 'ZIP archive' },
    docx: { bytes: [0x50, 0x4B, 0x03, 0x04], description: 'DOCX document' }, // Same as ZIP
    xlsx: { bytes: [0x50, 0x4B, 0x03, 0x04], description: 'XLSX spreadsheet' }, // Same as ZIP
    doc: { bytes: [0xD0, 0xCF, 0x11, 0xE0], description: 'DOC document' },
    xls: { bytes: [0xD0, 0xCF, 0x11, 0xE0], description: 'XLS spreadsheet' },
    png: { bytes: [0x89, 0x50, 0x4E, 0x47], description: 'PNG image' },
    jpg: { bytes: [0xFF, 0xD8, 0xFF], description: 'JPEG image' },
    gif: { bytes: [0x47, 0x49, 0x46, 0x38], description: 'GIF image' },
};

// HTML signatures that indicate an error page
const HTML_SIGNATURES = [
    '<!DOCTYPE',
    '<!doctype',
    '<html',
    '<HTML',
    '<?xml',
];

export class DownloadError extends Error {
    constructor(message, url, reason = 'unknown') {
        super(message);
        this.name = 'DownloadError';
        this.url = url;
        this.reason = reason;
    }
}

export class Downloader {
    constructor(options = {}) {
        this.downloadDir = options.downloadDir || './downloads';
        this.timeout = options.timeout || 30000;
    }

    /**
     * Download a file via Playwright
     * @param {import('playwright').Page} page - Playwright page
     * @param {string} url - URL to download
     * @param {string} expectedType - Expected file type (pdf, docx, etc.)
     * @returns {Promise<{path: string, hash: string, size: number}>}
     */
    async download(page, url, expectedType = null) {
        // Ensure download directory exists
        await fs.mkdir(this.downloadDir, { recursive: true });

        // Determine expected type from URL if not provided
        if (!expectedType) {
            const ext = path.extname(new URL(url).pathname).toLowerCase().replace('.', '');
            expectedType = ext || 'pdf';
        }

        console.log(`  Downloading: ${url}`);

        try {
            // Start download by clicking or navigating
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: this.timeout }),
                page.evaluate((downloadUrl) => {
                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }, url),
            ]);

            // Save to file
            const suggestedFilename = download.suggestedFilename();
            const filePath = path.join(this.downloadDir, `${Date.now()}_${suggestedFilename}`);
            await download.saveAs(filePath);

            // Validate the downloaded file
            const validation = await this.validateFile(filePath, expectedType);

            if (!validation.valid) {
                await fs.unlink(filePath).catch(() => { });
                throw new DownloadError(
                    `Invalid file content: ${validation.reason}`,
                    url,
                    validation.reason
                );
            }

            return {
                path: filePath,
                hash: validation.hash,
                size: validation.size,
                filename: suggestedFilename,
            };
        } catch (error) {
            if (error instanceof DownloadError) throw error;

            // Fallback: try direct fetch if Playwright download fails
            return this.downloadDirect(url, expectedType);
        }
    }

    /**
     * Direct download using fetch (fallback)
     * @param {string} url 
     * @param {string} expectedType 
     */
    async downloadDirect(url, expectedType) {
        console.log(`  Fallback: direct download for ${url}`);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        if (!response.ok) {
            throw new DownloadError(
                `HTTP ${response.status}: ${response.statusText}`,
                url,
                'http_error'
            );
        }

        // Check Content-Type header
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            throw new DownloadError(
                'Server returned HTML instead of document (likely error page)',
                url,
                'html_response'
            );
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // Generate filename
        const urlPath = new URL(url).pathname;
        const filename = path.basename(urlPath) || `download_${Date.now()}.${expectedType}`;
        const filePath = path.join(this.downloadDir, `${Date.now()}_${filename}`);

        await fs.writeFile(filePath, buffer);

        // Validate
        const validation = await this.validateFile(filePath, expectedType);

        if (!validation.valid) {
            await fs.unlink(filePath).catch(() => { });
            throw new DownloadError(
                `Invalid file content: ${validation.reason}`,
                url,
                validation.reason
            );
        }

        return {
            path: filePath,
            hash: validation.hash,
            size: validation.size,
            filename,
        };
    }

    /**
     * Validate a downloaded file using magic numbers
     * @param {string} filePath 
     * @param {string} expectedType 
     * @returns {Promise<{valid: boolean, reason?: string, hash?: string, size?: number}>}
     */
    async validateFile(filePath, expectedType) {
        const stats = await fs.stat(filePath);
        const buffer = await fs.readFile(filePath);

        // Check if file is empty
        if (buffer.length === 0) {
            return { valid: false, reason: 'empty_file' };
        }

        // Check for HTML error pages (common when session expires)
        const header = buffer.slice(0, 100).toString('utf-8');
        for (const sig of HTML_SIGNATURES) {
            if (header.includes(sig)) {
                return { valid: false, reason: 'html_error_page' };
            }
        }

        // Validate magic numbers if we have them
        const magicInfo = MAGIC_NUMBERS[expectedType];
        if (magicInfo) {
            const fileHeader = [...buffer.slice(0, magicInfo.bytes.length)];
            const matches = magicInfo.bytes.every((byte, i) => fileHeader[i] === byte);

            if (!matches) {
                // Check if it's a different valid document type
                const detectedType = this.detectFileType(buffer);
                if (detectedType) {
                    console.log(`  Note: Expected ${expectedType}, got ${detectedType}`);
                    // Allow if it's still a valid document type
                } else {
                    return { valid: false, reason: `invalid_magic_number_for_${expectedType}` };
                }
            }
        }

        // Calculate hash
        const hash = createHash('sha256').update(buffer).digest('hex');

        return {
            valid: true,
            hash,
            size: stats.size,
        };
    }

    /**
     * Detect file type from magic numbers
     * @param {Buffer} buffer 
     * @returns {string|null}
     */
    detectFileType(buffer) {
        for (const [type, info] of Object.entries(MAGIC_NUMBERS)) {
            const fileHeader = [...buffer.slice(0, info.bytes.length)];
            if (info.bytes.every((byte, i) => fileHeader[i] === byte)) {
                return type;
            }
        }
        return null;
    }

    /**
     * Clean up old downloads
     * @param {number} maxAgeMs - Maximum age in milliseconds
     */
    async cleanup(maxAgeMs = 3600000) {
        try {
            const files = await fs.readdir(this.downloadDir);
            const now = Date.now();

            for (const file of files) {
                const filePath = path.join(this.downloadDir, file);
                const stats = await fs.stat(filePath);

                if (now - stats.mtimeMs > maxAgeMs) {
                    await fs.unlink(filePath);
                    console.log(`  Cleaned up: ${file}`);
                }
            }
        } catch (error) {
            // Directory might not exist, that's OK
        }
    }
}

export default Downloader;
