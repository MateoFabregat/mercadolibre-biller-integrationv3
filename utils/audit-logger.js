/**
 * Audit Logger
 *
 * Registra todas las acciones importantes del sistema para auditoría.
 * Mantiene un historial completo de operaciones de facturación.
 *
 * @module utils/audit-logger
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Tipos de acciones auditables
 */
const AUDIT_ACTIONS = {
  // Comprobantes
  COMPROBANTE_EMITIDO: 'comprobante_emitido',
  COMPROBANTE_FALLIDO: 'comprobante_fallido',
  COMPROBANTE_REINTENTADO: 'comprobante_reintentado',

  // Notas de crédito
  NC_EMITIDA: 'nc_emitida',
  NC_FALLIDA: 'nc_fallida',

  // Webhooks
  WEBHOOK_RECIBIDO: 'webhook_recibido',
  WEBHOOK_PROCESADO: 'webhook_procesado',
  WEBHOOK_DUPLICADO: 'webhook_duplicado',
  WEBHOOK_ERROR: 'webhook_error',

  // Decisiones de facturación
  DECISION_EFACTURA: 'decision_efactura',
  DECISION_ETICKET: 'decision_eticket',
  DECISION_SUPERA_LIMITE: 'decision_supera_limite',

  // Validaciones
  RUT_VALIDADO_DGI: 'rut_validado_dgi',
  RUT_INVALIDO: 'rut_invalido',

  // Sistema
  SERVIDOR_INICIADO: 'servidor_iniciado',
  SERVIDOR_DETENIDO: 'servidor_detenido',
  RECONCILIACION_EJECUTADA: 'reconciliacion_ejecutada',
  CONFIG_ACTUALIZADA: 'config_actualizada'
};

/**
 * Clase para auditoría
 */
class AuditLogger {
  constructor(options = {}) {
    this.logsDir = options.logsDir || './data/audit';
    this.maxEntriesPerFile = options.maxEntriesPerFile || 10000;
    this.retentionDays = options.retentionDays || 90;

    this.currentFile = null;
    this.entriesInCurrentFile = 0;

    // Crear directorio si no existe
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Buffer de entradas (para escritura en batch)
    this.buffer = [];
    this.bufferFlushInterval = options.bufferFlushInterval || 5000; // 5 segundos

    // Flush periódico
    this.flushTimer = setInterval(() => this.flush(), this.bufferFlushInterval);

    // Limpiar archivos antiguos
    this._cleanupOldFiles();

    logger.info('AuditLogger inicializado', {
      logsDir: this.logsDir,
      retentionDays: this.retentionDays
    });
  }

  /**
   * Registra una acción de auditoría
   * @param {string} action - Tipo de acción
   * @param {Object} data - Datos de la acción
   * @returns {Object} Entrada de auditoría
   */
  log(action, data = {}) {
    const entry = {
      id: this._generateId(),
      timestamp: new Date().toISOString(),
      action,
      actor: data.actor || 'system',

      // Identificadores
      orderId: data.orderId || null,
      refundId: data.refundId || null,
      comprobanteId: data.comprobanteId || null,

      // Resultado
      result: data.result || 'success', // success, failure, skipped
      resultCode: data.resultCode || null,
      message: data.message || null,

      // Detalles específicos
      details: data.details || {},

      // Metadata
      duration: data.duration || null,
      ip: data.ip || null,
      userAgent: data.userAgent || null
    };

    this.buffer.push(entry);

    // Flush inmediato si buffer grande
    if (this.buffer.length >= 100) {
      this.flush();
    }

    return entry;
  }

  // ============ Métodos de conveniencia ============

  /**
   * Registra emisión de comprobante exitosa
   */
  comprobanteEmitido(data) {
    return this.log(AUDIT_ACTIONS.COMPROBANTE_EMITIDO, {
      orderId: data.orderId,
      comprobanteId: data.comprobanteId,
      result: 'success',
      details: {
        tipo: data.tipo,
        serie: data.serie,
        numero: data.numero,
        cae: data.cae,
        monto: data.monto,
        cliente: data.cliente
      },
      duration: data.duration
    });
  }

  /**
   * Registra fallo en emisión de comprobante
   */
  comprobanteFallido(data) {
    return this.log(AUDIT_ACTIONS.COMPROBANTE_FALLIDO, {
      orderId: data.orderId,
      result: 'failure',
      resultCode: data.errorCode,
      message: data.errorMessage,
      details: {
        intentos: data.intentos,
        error: data.error
      }
    });
  }

  /**
   * Registra emisión de NC exitosa
   */
  ncEmitida(data) {
    return this.log(AUDIT_ACTIONS.NC_EMITIDA, {
      orderId: data.orderId,
      refundId: data.refundId,
      comprobanteId: data.ncId,
      result: 'success',
      details: {
        tipo: data.tipo,
        serie: data.serie,
        numero: data.numero,
        monto: data.monto,
        comprobanteOriginalId: data.comprobanteOriginalId
      }
    });
  }

  /**
   * Registra webhook recibido
   */
  webhookRecibido(data) {
    return this.log(AUDIT_ACTIONS.WEBHOOK_RECIBIDO, {
      result: 'success',
      details: {
        topic: data.topic,
        shopifyWebhookId: data.webhookId,
        resourceId: data.resourceId
      },
      ip: data.ip
    });
  }

  /**
   * Registra decisión de facturación
   */
  decisionFacturacion(data) {
    const action = data.tipoComprobante === 111
      ? AUDIT_ACTIONS.DECISION_EFACTURA
      : data.superaLimite
        ? AUDIT_ACTIONS.DECISION_SUPERA_LIMITE
        : AUDIT_ACTIONS.DECISION_ETICKET;

    return this.log(action, {
      orderId: data.orderId,
      result: 'success',
      details: {
        tipoComprobante: data.tipoComprobante,
        montoNeto: data.montoNeto,
        montoEnUI: data.montoEnUI,
        tieneRUT: data.tieneRUT,
        rutValido: data.rutValido,
        superaLimite: data.superaLimite
      }
    });
  }

  /**
   * Registra validación de RUT con DGI
   */
  rutValidado(data) {
    const action = data.valido ? AUDIT_ACTIONS.RUT_VALIDADO_DGI : AUDIT_ACTIONS.RUT_INVALIDO;

    return this.log(action, {
      orderId: data.orderId,
      result: data.valido ? 'success' : 'failure',
      details: {
        rut: data.rut,
        razonSocial: data.razonSocial,
        source: data.source
      }
    });
  }

  /**
   * Registra ejecución de reconciliación
   */
  reconciliacionEjecutada(data) {
    return this.log(AUDIT_ACTIONS.RECONCILIACION_EJECUTADA, {
      result: data.discrepancias > 0 ? 'warning' : 'success',
      details: {
        tipo: data.tipo,
        total: data.total,
        verificados: data.verificados,
        discrepancias: data.discrepancias,
        errores: data.errores,
        reporteId: data.reporteId
      },
      duration: data.duration
    });
  }

  // ============ Consultas ============

  /**
   * Obtiene entradas de auditoría por rango de fechas
   * @param {Date} desde - Fecha inicio
   * @param {Date} hasta - Fecha fin
   * @param {Object} filtros - Filtros adicionales
   * @returns {Array} Entradas
   */
  query(desde, hasta, filtros = {}) {
    const entries = [];
    const files = this._getFilesInRange(desde, hasta);

    for (const file of files) {
      const fileEntries = this._readFile(file);

      for (const entry of fileEntries) {
        const entryDate = new Date(entry.timestamp);

        if (entryDate >= desde && entryDate <= hasta) {
          // Aplicar filtros
          if (filtros.action && entry.action !== filtros.action) continue;
          if (filtros.orderId && entry.orderId !== filtros.orderId) continue;
          if (filtros.result && entry.result !== filtros.result) continue;

          entries.push(entry);
        }
      }
    }

    return entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  /**
   * Obtiene entradas de auditoría de las últimas N horas
   * @param {number} hours - Horas
   * @returns {Array} Entradas
   */
  getRecent(hours = 24) {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - hours * 60 * 60 * 1000);
    return this.query(desde, hasta);
  }

  /**
   * Obtiene entradas de auditoría por orden
   * @param {string} orderId - ID del pedido
   * @returns {Array} Entradas
   */
  getByOrder(orderId) {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 días
    return this.query(desde, hasta, { orderId });
  }

  /**
   * Obtiene estadísticas de auditoría
   * @param {number} days - Días a analizar
   * @returns {Object} Estadísticas
   */
  getStats(days = 7) {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - days * 24 * 60 * 60 * 1000);
    const entries = this.query(desde, hasta);

    const stats = {
      total: entries.length,
      byAction: {},
      byResult: {},
      byDay: {},
      comprobantes: {
        emitidos: 0,
        fallidos: 0,
        ncEmitidas: 0
      }
    };

    for (const entry of entries) {
      // Por acción
      stats.byAction[entry.action] = (stats.byAction[entry.action] || 0) + 1;

      // Por resultado
      stats.byResult[entry.result] = (stats.byResult[entry.result] || 0) + 1;

      // Por día
      const day = entry.timestamp.split('T')[0];
      stats.byDay[day] = (stats.byDay[day] || 0) + 1;

      // Contadores específicos
      if (entry.action === AUDIT_ACTIONS.COMPROBANTE_EMITIDO) {
        stats.comprobantes.emitidos++;
      } else if (entry.action === AUDIT_ACTIONS.COMPROBANTE_FALLIDO) {
        stats.comprobantes.fallidos++;
      } else if (entry.action === AUDIT_ACTIONS.NC_EMITIDA) {
        stats.comprobantes.ncEmitidas++;
      }
    }

    return stats;
  }

  // ============ Gestión de archivos ============

  /**
   * Escribe buffer a disco
   */
  flush() {
    if (this.buffer.length === 0) return;

    const entries = [...this.buffer];
    this.buffer = [];

    try {
      const filename = this._getCurrentFilename();
      const filepath = path.join(this.logsDir, filename);

      // Leer archivo existente o crear array vacío
      let existing = [];
      if (fs.existsSync(filepath)) {
        try {
          const content = fs.readFileSync(filepath, 'utf8');
          existing = JSON.parse(content);
        } catch {
          existing = [];
        }
      }

      // Agregar nuevas entradas
      const combined = [...existing, ...entries];

      // Guardar
      fs.writeFileSync(filepath, JSON.stringify(combined, null, 2));

      this.entriesInCurrentFile = combined.length;

      // Rotar archivo si excede límite
      if (this.entriesInCurrentFile >= this.maxEntriesPerFile) {
        this.currentFile = null;
        this.entriesInCurrentFile = 0;
      }

    } catch (error) {
      logger.error(`Error en flush de AuditLogger: ${error.message}`);
      // Re-agregar al buffer
      this.buffer = [...entries, ...this.buffer];
    }
  }

  /**
   * Obtiene el nombre del archivo actual
   * @private
   */
  _getCurrentFilename() {
    if (!this.currentFile || this.entriesInCurrentFile >= this.maxEntriesPerFile) {
      const date = new Date().toISOString().split('T')[0];
      const time = Date.now().toString(36);
      this.currentFile = `audit-${date}-${time}.json`;
      this.entriesInCurrentFile = 0;
    }
    return this.currentFile;
  }

  /**
   * Obtiene archivos en un rango de fechas
   * @private
   */
  _getFilesInRange(desde, hasta) {
    const desdeStr = desde.toISOString().split('T')[0];
    const hastaStr = hasta.toISOString().split('T')[0];

    try {
      return fs.readdirSync(this.logsDir)
        .filter(f => f.startsWith('audit-') && f.endsWith('.json'))
        .filter(f => {
          const dateMatch = f.match(/audit-(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) return false;
          const fileDate = dateMatch[1];
          return fileDate >= desdeStr && fileDate <= hastaStr;
        })
        .map(f => path.join(this.logsDir, f));
    } catch {
      return [];
    }
  }

  /**
   * Lee un archivo de auditoría
   * @private
   */
  _readFile(filepath) {
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  /**
   * Limpia archivos antiguos
   * @private
   */
  _cleanupOldFiles() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    try {
      const files = fs.readdirSync(this.logsDir)
        .filter(f => f.startsWith('audit-') && f.endsWith('.json'));

      for (const file of files) {
        const dateMatch = file.match(/audit-(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dateMatch[1] < cutoffStr) {
          fs.unlinkSync(path.join(this.logsDir, file));
          logger.debug(`Archivo de auditoría eliminado: ${file}`);
        }
      }
    } catch (error) {
      logger.error(`Error limpiando archivos de auditoría: ${error.message}`);
    }
  }

  /**
   * Genera ID único
   * @private
   */
  _generateId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `aud-${timestamp}-${random}`;
  }

  /**
   * Detiene el logger
   */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}

// Singleton
let instance = null;

function getAuditLogger(options = {}) {
  if (!instance) {
    instance = new AuditLogger(options);
  }
  return instance;
}

module.exports = {
  AuditLogger,
  getAuditLogger,
  AUDIT_ACTIONS
};
