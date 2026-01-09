/**
 * TelegramNotifier - Telegram Bot API integration
 * Sends documents and error notifications via Telegram
 */

import { promises as fs } from 'fs';
import path from 'path';

export class TelegramNotifier {
    constructor(options = {}) {
        this.botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN;
        this.chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
        this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
        this.retryDelay = options.retryDelay || 1000;
        this.maxRetries = options.maxRetries || 3;
    }

    /**
     * Check if notifier is configured
     */
    isConfigured() {
        return !!(this.botToken && this.chatId);
    }

    /**
     * Send a text message
     * @param {string} text 
     * @param {Object} options 
     */
    async sendMessage(text, options = {}) {
        if (!this.isConfigured()) {
            console.log('  [Telegram] Not configured, skipping message');
            return null;
        }

        return this.apiCall('sendMessage', {
            chat_id: this.chatId,
            text,
            parse_mode: options.parseMode || 'HTML',
            disable_web_page_preview: options.disablePreview ?? true,
        });
    }

    /**
     * Send a document file
     * @param {string} filePath - Path to file
     * @param {string} caption - Caption text
     * @param {Object} options 
     */
    async sendDocument(filePath, caption, options = {}) {
        if (!this.isConfigured()) {
            console.log('  [Telegram] Not configured, skipping document');
            return null;
        }

        const fileBuffer = await fs.readFile(filePath);
        const filename = options.filename || path.basename(filePath);

        const formData = new FormData();
        formData.append('chat_id', this.chatId);
        formData.append('document', new Blob([fileBuffer]), filename);
        if (caption) {
            formData.append('caption', caption);
            formData.append('parse_mode', 'HTML');
        }

        return this.apiCallFormData('sendDocument', formData);
    }

    /**
     * Send a photo (screenshot)
     * @param {Buffer|string} photo - Photo buffer or file path
     * @param {string} caption 
     */
    async sendPhoto(photo, caption) {
        if (!this.isConfigured()) {
            console.log('  [Telegram] Not configured, skipping photo');
            return null;
        }

        let photoBuffer;
        if (Buffer.isBuffer(photo)) {
            photoBuffer = photo;
        } else {
            photoBuffer = await fs.readFile(photo);
        }

        const formData = new FormData();
        formData.append('chat_id', this.chatId);
        formData.append('photo', new Blob([photoBuffer]), 'screenshot.png');
        if (caption) {
            formData.append('caption', caption.substring(0, 1024)); // Telegram limit
            formData.append('parse_mode', 'HTML');
        }

        return this.apiCallFormData('sendPhoto', formData);
    }

    /**
     * Send new document notification
     * @param {string} siteName 
     * @param {Object} doc 
     * @param {string} filePath 
     */
    async notifyNewDocument(siteName, doc, filePath) {
        const caption = `📄 <b>[${this.escapeHtml(siteName)}]</b>\n` +
            `<b>Nuevo:</b> ${this.escapeHtml(doc.title || 'Sin título')}\n` +
            (doc.date ? `📅 ${this.escapeHtml(doc.date)}\n` : '') +
            `🔗 <a href="${doc.url}">Ver original</a>`;

        if (filePath) {
            return this.sendDocument(filePath, caption);
        } else {
            return this.sendMessage(caption);
        }
    }

    /**
     * Send updated document notification
     * @param {string} siteName 
     * @param {Object} doc 
     * @param {string} filePath 
     * @param {string} reason 
     */
    async notifyUpdatedDocument(siteName, doc, filePath, reason = 'hash_changed') {
        const reasonText = reason === 'hash_changed'
            ? '(contenido modificado)'
            : '(nueva URL)';

        const caption = `🔄 <b>[${this.escapeHtml(siteName)}]</b>\n` +
            `<b>Actualizado:</b> ${this.escapeHtml(doc.title || 'Sin título')} ${reasonText}\n` +
            (doc.date ? `📅 ${this.escapeHtml(doc.date)}\n` : '') +
            `🔗 <a href="${doc.url}">Ver original</a>`;

        if (filePath) {
            return this.sendDocument(filePath, caption);
        } else {
            return this.sendMessage(caption);
        }
    }

    /**
     * Send error notification
     * @param {string} siteName 
     * @param {Error} error 
     * @param {Object} context 
     */
    async notifyError(siteName, error, context = {}) {
        const message = `❌ <b>[${this.escapeHtml(siteName)}] Error</b>\n\n` +
            `<b>URL:</b> ${this.escapeHtml(context.url || 'N/A')}\n` +
            (context.step ? `<b>Paso:</b> ${this.escapeHtml(JSON.stringify(context.step))}\n` : '') +
            `<b>Error:</b> <code>${this.escapeHtml(error.message)}</code>\n` +
            (error.stack ? `\n<pre>${this.escapeHtml(error.stack.substring(0, 500))}</pre>` : '');

        // Send text message first
        await this.sendMessage(message);

        // Send screenshot if available
        if (context.screenshot) {
            await this.sendPhoto(context.screenshot, `Screenshot del error en ${siteName}`);
        }
    }

    /**
     * Make API call with JSON body
     * @param {string} method 
     * @param {Object} body 
     */
    async apiCall(method, body) {
        return this.withRetry(async () => {
            const response = await fetch(`${this.apiBase}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const result = await response.json();

            if (!result.ok) {
                throw new Error(`Telegram API error: ${result.description}`);
            }

            return result;
        });
    }

    /**
     * Make API call with FormData body
     * @param {string} method 
     * @param {FormData} formData 
     */
    async apiCallFormData(method, formData) {
        return this.withRetry(async () => {
            const response = await fetch(`${this.apiBase}/${method}`, {
                method: 'POST',
                body: formData,
            });

            const result = await response.json();

            if (!result.ok) {
                throw new Error(`Telegram API error: ${result.description}`);
            }

            return result;
        });
    }

    /**
     * Retry wrapper with delay
     * @param {Function} fn 
     */
    async withRetry(fn) {
        let lastError;

        for (let i = 0; i < this.maxRetries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                console.log(`  [Telegram] Retry ${i + 1}/${this.maxRetries}: ${error.message}`);
                await this.sleep(this.retryDelay * (i + 1));
            }
        }

        throw lastError;
    }

    /**
     * Escape HTML entities
     * @param {string} text 
     */
    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /**
     * Sleep helper
     * @param {number} ms 
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default TelegramNotifier;
