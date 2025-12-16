/**
 * Sistema de logging profesional
 * @module utils/logger
 */

const config = require('../config');

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const COLORS = {
  error: '\x1b[31m',   // Rojo
  warn: '\x1b[33m',    // Amarillo
  info: '\x1b[36m',    // Cyan
  debug: '\x1b[90m',   // Gris
  reset: '\x1b[0m'
};

const ICONS = {
  error: '❌',
  warn: '⚠️',
  info: 'ℹ️',
  debug: '🔍'
};

class Logger {
  constructor() {
    this.level = LEVELS[config.logging?.level] ?? LEVELS.info;
    this.format = config.logging?.format || 'pretty';
  }

  /**
   * Formatear timestamp
   */
  timestamp() {
    return new Date().toISOString();
  }

  /**
   * Formatear mensaje según formato configurado
   */
  formatMessage(level, message, data = {}) {
    const ts = this.timestamp();
    
    if (this.format === 'json') {
      return JSON.stringify({
        timestamp: ts,
        level,
        message,
        ...data
      });
    }
    
    // Formato pretty
    const color = COLORS[level] || '';
    const icon = ICONS[level] || '';
    const reset = COLORS.reset;
    
    let dataStr = '';
    if (data && Object.keys(data).length > 0) {
      // Filtrar datos sensibles
      const safaData = this.sanitizeData(data);
      dataStr = ` ${color}${JSON.stringify(safaData)}${reset}`;
    }
    
    return `${color}[${ts}] ${icon} ${level.toUpperCase()}${reset}: ${message}${dataStr}`;
  }

  /**
   * Sanitizar datos sensibles
   */
  sanitizeData(data) {
    const sensitiveKeys = ['token', 'password', 'secret', 'accessToken', 'api_key'];
    const result = { ...data };
    
    for (const key of Object.keys(result)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        result[key] = '[REDACTED]';
      } else if (typeof result[key] === 'object' && result[key] !== null) {
        result[key] = this.sanitizeData(result[key]);
      }
    }
    
    return result;
  }

  /**
   * Log de error
   */
  error(message, data = {}) {
    if (this.level >= LEVELS.error) {
      console.error(this.formatMessage('error', message, data));
    }
  }

  /**
   * Log de warning
   */
  warn(message, data = {}) {
    if (this.level >= LEVELS.warn) {
      console.warn(this.formatMessage('warn', message, data));
    }
  }

  /**
   * Log de info
   */
  info(message, data = {}) {
    if (this.level >= LEVELS.info) {
      console.log(this.formatMessage('info', message, data));
    }
  }

  /**
   * Log de debug
   */
  debug(message, data = {}) {
    if (this.level >= LEVELS.debug) {
      console.log(this.formatMessage('debug', message, data));
    }
  }

  /**
   * Log de request HTTP (útil para debugging)
   */
  request(method, url, status, duration) {
    const statusColor = status >= 400 ? COLORS.error : 
                        status >= 300 ? COLORS.warn : COLORS.info;
    
    if (this.level >= LEVELS.debug) {
      console.log(
        `${COLORS.debug}[${this.timestamp()}]${COLORS.reset} ` +
        `${method} ${url} ${statusColor}${status}${COLORS.reset} ${duration}ms`
      );
    }
  }

  /**
   * Log de inicio de operación (para tracking)
   */
  startOperation(operationId, name, data = {}) {
    this.debug(`▶ Starting: ${name}`, { operationId, ...data });
    return {
      end: (result = {}) => {
        this.debug(`✓ Completed: ${name}`, { operationId, ...result });
      },
      fail: (error) => {
        this.error(`✗ Failed: ${name}`, { operationId, error: error.message });
      }
    };
  }
}

// Singleton
const logger = new Logger();

module.exports = logger;
