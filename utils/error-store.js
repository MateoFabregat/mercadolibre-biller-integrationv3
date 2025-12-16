/**
 * Error Store
 *
 * Almacena errores de forma persistente para análisis y resolución posterior.
 * Permite categorizar, filtrar y resolver errores.
 *
 * @module utils/error-store
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Tipos de errores
 */
const ERROR_TYPES = {
  BILLER_ERROR: 'biller_error',
  SHOPIFY_ERROR: 'shopify_error',
  VALIDATION_ERROR: 'validation_error',
  NETWORK_ERROR: 'network_error',
  PROCESSING_ERROR: 'processing_error',
  WEBHOOK_ERROR: 'webhook_error',
  UNKNOWN_ERROR: 'unknown_error'
};

/**
 * Clase para almacenar y gestionar errores
 */
class ErrorStore {
  constructor(options = {}) {
    this.filePath = options.filePath || './data/errors.json';
    this.maxErrors = options.maxErrors || 1000;
    this.autoSaveInterval = options.autoSaveInterval || 60000; // 1 minuto

    this.errors = new Map();
    this.dirty = false;

    // Crear directorio si no existe
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Cargar errores existentes
    this.load();

    // Auto-guardado
    this.autoSaveTimer = setInterval(() => this.save(), this.autoSaveInterval);

    logger.info('ErrorStore inicializado', {
      filePath: this.filePath,
      erroresExistentes: this.errors.size
    });
  }

  /**
   * Carga errores desde archivo
   */
  load() {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(content);

      if (data.errors && typeof data.errors === 'object') {
        this.errors = new Map(Object.entries(data.errors));
      }

      logger.debug(`ErrorStore: ${this.errors.size} errores cargados`);

    } catch (error) {
      logger.error(`Error cargando ErrorStore: ${error.message}`);
    }
  }

  /**
   * Guarda errores en archivo
   */
  save() {
    if (!this.dirty) return;

    try {
      const data = {
        version: 1,
        updated_at: new Date().toISOString(),
        total: this.errors.size,
        errors: Object.fromEntries(this.errors)
      };

      // Escritura atómica
      const tempPath = this.filePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
      fs.renameSync(tempPath, this.filePath);

      this.dirty = false;

    } catch (error) {
      logger.error(`Error guardando ErrorStore: ${error.message}`);
    }
  }

  /**
   * Registra un nuevo error
   * @param {Error|Object} error - Error a registrar
   * @param {Object} context - Contexto adicional
   * @returns {string} ID del error
   */
  recordError(error, context = {}) {
    const errorId = this._generateId();

    const errorEntry = {
      id: errorId,
      timestamp: new Date().toISOString(),
      type: this._determineErrorType(error),
      message: error.message || String(error),
      code: error.code || null,
      status: error.status || null,

      // Stack trace (solo en desarrollo)
      stack: process.env.NODE_ENV !== 'production' ? error.stack : null,

      // Contexto
      context: {
        orderId: context.orderId || null,
        refundId: context.refundId || null,
        webhookId: context.webhookId || null,
        action: context.action || null,
        attempt: context.attempt || null,
        ...context
      },

      // Estado
      resolved: false,
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,

      // Metadata
      retryable: this._isRetryable(error),
      response: error.response || null
    };

    this.errors.set(errorId, errorEntry);
    this.dirty = true;

    // Limpiar errores antiguos si excede límite
    this._cleanup();

    logger.debug(`Error registrado: ${errorId}`, {
      type: errorEntry.type,
      message: errorEntry.message
    });

    return errorId;
  }

  /**
   * Obtiene un error por ID
   * @param {string} errorId - ID del error
   * @returns {Object|null} Error o null
   */
  getError(errorId) {
    return this.errors.get(errorId) || null;
  }

  /**
   * Obtiene errores no resueltos
   * @param {Object} options - Opciones de filtrado
   * @returns {Array} Errores no resueltos
   */
  getUnresolvedErrors(options = {}) {
    const { type, limit = 100, since } = options;

    let errors = Array.from(this.errors.values())
      .filter(e => !e.resolved);

    if (type) {
      errors = errors.filter(e => e.type === type);
    }

    if (since) {
      const sinceDate = new Date(since);
      errors = errors.filter(e => new Date(e.timestamp) >= sinceDate);
    }

    return errors
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  /**
   * Obtiene errores por tipo
   * @param {string} type - Tipo de error
   * @param {Object} options - Opciones
   * @returns {Array} Errores del tipo especificado
   */
  getErrorsByType(type, options = {}) {
    const { resolved, limit = 100 } = options;

    let errors = Array.from(this.errors.values())
      .filter(e => e.type === type);

    if (resolved !== undefined) {
      errors = errors.filter(e => e.resolved === resolved);
    }

    return errors
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  /**
   * Obtiene errores por orden de Shopify
   * @param {string} orderId - ID del pedido
   * @returns {Array} Errores del pedido
   */
  getErrorsByOrder(orderId) {
    return Array.from(this.errors.values())
      .filter(e => e.context.orderId === orderId)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /**
   * Marca un error como resuelto
   * @param {string} errorId - ID del error
   * @param {Object} resolution - Detalles de la resolución
   * @returns {boolean} true si se resolvió correctamente
   */
  resolveError(errorId, resolution = {}) {
    const error = this.errors.get(errorId);

    if (!error) {
      return false;
    }

    error.resolved = true;
    error.resolution = resolution.notes || 'Resuelto';
    error.resolvedAt = new Date().toISOString();
    error.resolvedBy = resolution.by || 'system';

    this.dirty = true;

    logger.info(`Error resuelto: ${errorId}`, {
      resolution: error.resolution
    });

    return true;
  }

  /**
   * Marca múltiples errores como resueltos
   * @param {Array} errorIds - IDs de errores
   * @param {Object} resolution - Detalles de la resolución
   * @returns {number} Cantidad de errores resueltos
   */
  resolveMultiple(errorIds, resolution = {}) {
    let count = 0;

    for (const errorId of errorIds) {
      if (this.resolveError(errorId, resolution)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Obtiene estadísticas de errores
   * @returns {Object} Estadísticas
   */
  getStats() {
    const errors = Array.from(this.errors.values());

    const byType = {};
    const byDay = {};
    let resolved = 0;
    let unresolved = 0;
    let retryable = 0;

    for (const error of errors) {
      // Por tipo
      byType[error.type] = (byType[error.type] || 0) + 1;

      // Por día
      const day = error.timestamp.split('T')[0];
      byDay[day] = (byDay[day] || 0) + 1;

      // Contadores
      if (error.resolved) {
        resolved++;
      } else {
        unresolved++;
      }

      if (error.retryable) {
        retryable++;
      }
    }

    // Últimos 7 días
    const last7Days = {};
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      last7Days[dateStr] = byDay[dateStr] || 0;
    }

    return {
      total: errors.length,
      resolved,
      unresolved,
      retryable,
      byType,
      last7Days,
      oldestUnresolved: errors
        .filter(e => !e.resolved)
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0]?.timestamp || null
    };
  }

  /**
   * Limpia errores antiguos
   * @private
   */
  _cleanup() {
    if (this.errors.size <= this.maxErrors) return;

    // Ordenar por timestamp y mantener solo los más recientes
    const sorted = Array.from(this.errors.entries())
      .sort((a, b) => new Date(b[1].timestamp) - new Date(a[1].timestamp));

    // Priorizar mantener errores no resueltos
    const unresolved = sorted.filter(([_, e]) => !e.resolved);
    const resolved = sorted.filter(([_, e]) => e.resolved);

    // Mantener todos los no resueltos + los resueltos más recientes hasta maxErrors
    const toKeep = [
      ...unresolved,
      ...resolved.slice(0, this.maxErrors - unresolved.length)
    ].slice(0, this.maxErrors);

    this.errors = new Map(toKeep);
    this.dirty = true;

    logger.debug(`ErrorStore cleanup: ${sorted.length} -> ${this.errors.size} errores`);
  }

  /**
   * Determina el tipo de error
   * @private
   */
  _determineErrorType(error) {
    if (error.type && Object.values(ERROR_TYPES).includes(error.type)) {
      return error.type;
    }

    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      return ERROR_TYPES.NETWORK_ERROR;
    }

    if (error.name === 'BillerError' || error.message?.includes('Biller')) {
      return ERROR_TYPES.BILLER_ERROR;
    }

    if (error.name === 'ShopifyError' || error.message?.includes('Shopify')) {
      return ERROR_TYPES.SHOPIFY_ERROR;
    }

    if (error.code === 'VALIDATION_ERROR' || error.message?.includes('validación')) {
      return ERROR_TYPES.VALIDATION_ERROR;
    }

    return ERROR_TYPES.UNKNOWN_ERROR;
  }

  /**
   * Determina si el error es retriable
   * @private
   */
  _isRetryable(error) {
    const nonRetryableCodes = [
      'VALIDATION_ERROR',
      'INVALID_TOKEN',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'DUPLICATE'
    ];

    if (nonRetryableCodes.includes(error.code)) {
      return false;
    }

    // Errores de red son retriables
    if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) {
      return true;
    }

    // 5xx son retriables
    if (error.status >= 500) {
      return true;
    }

    // 429 (rate limit) es retriable
    if (error.status === 429) {
      return true;
    }

    // 4xx no son retriables
    if (error.status >= 400 && error.status < 500) {
      return false;
    }

    return true;
  }

  /**
   * Genera ID único
   * @private
   */
  _generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `err-${timestamp}-${random}`;
  }

  /**
   * Detiene el auto-guardado
   */
  stopAutoSave() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.save();
  }

  /**
   * Getter para cantidad de errores
   */
  get size() {
    return this.errors.size;
  }
}

// Singleton
let instance = null;

function getErrorStore(options = {}) {
  if (!instance) {
    instance = new ErrorStore(options);
  }
  return instance;
}

module.exports = {
  ErrorStore,
  getErrorStore,
  ERROR_TYPES
};
