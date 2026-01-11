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
        let titleLine = `<b>Nuevo:</b> ${this.escapeHtml(doc.title || 'Sin título')}`;

        // Include expediente number if available (for Licitaciones/Contratos Menores)
        if (doc.expediente) {
            titleLine = `<b>Nuevo:</b> [${this.escapeHtml(doc.expediente)}] ${this.escapeHtml(doc.title || 'Sin título')}`;
        }

        const caption = `📄 <b>[${this.escapeHtml(siteName)}]</b>\n` +
            `${titleLine}\n` +
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

        let titleLine = `<b>Actualizado:</b> ${this.escapeHtml(doc.title || 'Sin título')} ${reasonText}`;

        // Include expediente number if available (for Licitaciones/Contratos Menores)
        if (doc.expediente) {
            titleLine = `<b>Actualizado:</b> [${this.escapeHtml(doc.expediente)}] ${this.escapeHtml(doc.title || 'Sin título')} ${reasonText}`;
        }

        const caption = `🔄 <b>[${this.escapeHtml(siteName)}]</b>\n` +
            `${titleLine}\n` +
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
        const timestamp = new Date().toLocaleString('es-ES', {
            timeZone: 'Europe/Madrid',
            dateStyle: 'short',
            timeStyle: 'medium'
        });

        // Build detailed error message
        let message = `❌ <b>[${this.escapeHtml(siteName)}] Monitor Fallido</b>\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        // Error details
        message += `⏰ <b>Hora:</b> ${timestamp}\n`;
        message += `🌐 <b>URL:</b> ${this.escapeHtml(context.url || 'N/A')}\n`;

        if (context.siteId) {
            message += `🏷️ <b>Site ID:</b> <code>${this.escapeHtml(context.siteId)}</code>\n`;
        }

        // Step information if navigation failed
        if (context.step) {
            message += `\n📍 <b>Paso que falló:</b>\n`;
            message += `   • Acción: <code>${this.escapeHtml(context.step.action || 'unknown')}</code>\n`;

            if (context.step.selector) {
                message += `   • Selector: <code>${this.escapeHtml(context.step.selector)}</code>\n`;
            }
            if (context.stepIndex !== undefined) {
                message += `   • Paso #${context.stepIndex + 1} de ${context.totalSteps || '?'}\n`;
            }
        }

        // Error information
        message += `\n🔴 <b>Error:</b> ${this.escapeHtml(error.name || 'Error')}\n`;
        message += `<code>${this.escapeHtml(error.message)}</code>\n`;

        // Stack trace (truncated)
        if (error.stack && context.includeStack !== false) {
            const stackLines = error.stack.split('\n').slice(1, 4).join('\n');
            message += `\n<pre>${this.escapeHtml(stackLines)}</pre>`;
        }

        // Retry info
        if (context.retryCount !== undefined) {
            message += `\n\n🔄 Falló después de ${context.retryCount} reintentos`;
        }

        // Consecutive failure warning  
        if (context.consecutiveCount && context.consecutiveCount > 1) {
            message += `\n\n⚠️ <i>Este mismo error ha ocurrido ${context.consecutiveCount} veces consecutivas</i>`;
        }

        // Send text message first
        await this.sendMessage(message);

        // Send screenshot if available
        if (context.screenshot) {
            const caption = `📸 Captura del error en ${this.escapeHtml(siteName)}\n` +
                `${timestamp}`;
            await this.sendPhoto(context.screenshot, caption);
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
