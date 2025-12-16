/**
 * Reconciliation Service
 *
 * Verifica la consistencia entre los comprobantes locales y los de Biller.
 * Detecta discrepancias, comprobantes faltantes y errores de procesamiento.
 *
 * @module services/reconciliation-service
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Tipos de discrepancias
 */
const DISCREPANCY_TYPES = {
  MISSING_IN_BILLER: 'missing_in_biller',      // Existe local pero no en Biller
  MISSING_IN_LOCAL: 'missing_in_local',        // Existe en Biller pero no local
  DATA_MISMATCH: 'data_mismatch',              // Datos diferentes
  PROCESSING_ERROR: 'processing_error',        // Error durante procesamiento
  PENDING_EMISSION: 'pending_emission'         // Pendiente de emisión
};

/**
 * Severidades
 */
const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info'
};

/**
 * Clase para manejar reconciliación
 */
class ReconciliationService {
  constructor(options = {}) {
    this.billerClient = options.billerClient || null;
    this.comprobanteStore = options.comprobanteStore || null;
    this.reportsDir = options.reportsDir || './data/reconciliation-reports';

    // Crear directorio de reportes si no existe
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }

    // Historial de reconciliaciones
    this.history = [];

    logger.info('ReconciliationService inicializado', {
      reportsDir: this.reportsDir
    });
  }

  /**
   * Configura las dependencias del servicio
   */
  configure(options) {
    if (options.billerClient) this.billerClient = options.billerClient;
    if (options.comprobanteStore) this.comprobanteStore = options.comprobanteStore;
  }

  /**
   * Ejecuta reconciliación rápida (últimos N comprobantes)
   * @param {number} limit - Cantidad de comprobantes a verificar
   * @returns {Object} Resultado de la reconciliación
   */
  async reconciliacionRapida(limit = 100) {
    logger.info(`🔄 Iniciando reconciliación rápida (últimos ${limit} comprobantes)`);

    const startTime = Date.now();

    try {
      // Obtener comprobantes locales
      const comprobantesLocales = this.comprobanteStore.getAll()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit);

      const resultado = await this._reconciliar(comprobantesLocales);

      resultado.tipo = 'quick';
      resultado.limit = limit;
      resultado.duracionMs = Date.now() - startTime;

      // Guardar reporte
      await this._guardarReporte(resultado);

      return resultado;

    } catch (error) {
      logger.error('Error en reconciliación rápida', { error: error.message });
      throw error;
    }
  }

  /**
   * Ejecuta reconciliación completa (todos los comprobantes)
   * @returns {Object} Resultado de la reconciliación
   */
  async reconciliacionCompleta() {
    logger.info('🔄 Iniciando reconciliación completa');

    const startTime = Date.now();

    try {
      // Obtener todos los comprobantes locales
      const comprobantesLocales = this.comprobanteStore.getAll();

      const resultado = await this._reconciliar(comprobantesLocales);

      resultado.tipo = 'full';
      resultado.duracionMs = Date.now() - startTime;

      // Guardar reporte
      await this._guardarReporte(resultado);

      return resultado;

    } catch (error) {
      logger.error('Error en reconciliación completa', { error: error.message });
      throw error;
    }
  }

  /**
   * Lógica principal de reconciliación
   * @private
   */
  async _reconciliar(comprobantesLocales) {
    const discrepancias = [];
    const verificados = [];
    const errores = [];

    let procesados = 0;
    const total = comprobantesLocales.length;

    for (const local of comprobantesLocales) {
      procesados++;

      if (procesados % 50 === 0) {
        logger.debug(`Reconciliación: ${procesados}/${total} procesados`);
      }

      try {
        // Buscar en Biller
        let billerComprobante = null;

        if (local.id) {
          try {
            billerComprobante = await this.billerClient.obtenerComprobante(local.id);
          } catch (err) {
            if (err.status !== 404) {
              errores.push({
                comprobante: local,
                error: err.message,
                tipo: 'biller_fetch_error'
              });
              continue;
            }
          }
        }

        // Si no se encontró por ID, buscar por número interno
        if (!billerComprobante && local.shopify_order_id) {
          try {
            billerComprobante = await this.billerClient.buscarPorNumeroInterno(
              `shopify-${local.shopify_order_id}`
            );
          } catch (err) {
            // Ignorar error de búsqueda
          }
        }

        // Analizar resultado
        if (!billerComprobante) {
          // No encontrado en Biller
          discrepancias.push({
            tipo: DISCREPANCY_TYPES.MISSING_IN_BILLER,
            severity: SEVERITY.CRITICAL,
            local,
            biller: null,
            mensaje: `Comprobante ${local.id || local.key} no encontrado en Biller`,
            accionRecomendada: 'Verificar si la emisión falló y re-emitir si es necesario'
          });
        } else {
          // Verificar consistencia de datos
          const inconsistencias = this._verificarConsistencia(local, billerComprobante);

          if (inconsistencias.length > 0) {
            discrepancias.push({
              tipo: DISCREPANCY_TYPES.DATA_MISMATCH,
              severity: SEVERITY.MEDIUM,
              local,
              biller: billerComprobante,
              inconsistencias,
              mensaje: `Datos inconsistentes para comprobante ${local.id}`,
              accionRecomendada: 'Actualizar datos locales con los de Biller'
            });
          } else {
            verificados.push({
              local,
              biller: billerComprobante,
              verificadoAt: new Date().toISOString()
            });
          }
        }

      } catch (error) {
        errores.push({
          comprobante: local,
          error: error.message,
          tipo: 'verification_error'
        });
      }

      // Rate limiting: pequeña pausa entre llamadas
      await this._delay(100);
    }

    // Construir resultado
    const resultado = {
      id: this._generarReporteId(),
      timestamp: new Date().toISOString(),
      resumen: {
        total: comprobantesLocales.length,
        verificados: verificados.length,
        discrepancias: discrepancias.length,
        errores: errores.length,
        tasaExito: total > 0 ? Math.round((verificados.length / total) * 100) : 100
      },
      discrepancias,
      errores,
      verificados: verificados.slice(0, 10), // Solo primeros 10 para no saturar
      porSeveridad: {
        critical: discrepancias.filter(d => d.severity === SEVERITY.CRITICAL).length,
        high: discrepancias.filter(d => d.severity === SEVERITY.HIGH).length,
        medium: discrepancias.filter(d => d.severity === SEVERITY.MEDIUM).length,
        low: discrepancias.filter(d => d.severity === SEVERITY.LOW).length
      }
    };

    // Log resumen
    if (discrepancias.length > 0) {
      logger.warn(`⚠️ Reconciliación completada con ${discrepancias.length} discrepancias`, {
        total: resultado.resumen.total,
        verificados: resultado.resumen.verificados,
        critical: resultado.porSeveridad.critical
      });
    } else {
      logger.info(`✅ Reconciliación completada sin discrepancias`, {
        total: resultado.resumen.total,
        verificados: resultado.resumen.verificados
      });
    }

    return resultado;
  }

  /**
   * Verifica consistencia entre comprobante local y de Biller
   * @private
   */
  _verificarConsistencia(local, biller) {
    const inconsistencias = [];

    // Verificar tipo de comprobante
    if (local.tipo_comprobante && biller.tipo_comprobante &&
        local.tipo_comprobante !== biller.tipo_comprobante) {
      inconsistencias.push({
        campo: 'tipo_comprobante',
        local: local.tipo_comprobante,
        biller: biller.tipo_comprobante
      });
    }

    // Verificar serie
    if (local.serie && biller.serie && local.serie !== biller.serie) {
      inconsistencias.push({
        campo: 'serie',
        local: local.serie,
        biller: biller.serie
      });
    }

    // Verificar número
    if (local.numero && biller.numero &&
        String(local.numero) !== String(biller.numero)) {
      inconsistencias.push({
        campo: 'numero',
        local: local.numero,
        biller: biller.numero
      });
    }

    // Verificar CAE
    if (local.cae_numero && biller.cae_numero &&
        local.cae_numero !== biller.cae_numero) {
      inconsistencias.push({
        campo: 'cae_numero',
        local: local.cae_numero,
        biller: biller.cae_numero
      });
    }

    return inconsistencias;
  }

  /**
   * Guarda el reporte de reconciliación
   * @private
   */
  async _guardarReporte(resultado) {
    const filename = `reconciliation-${resultado.id}.json`;
    const filepath = path.join(this.reportsDir, filename);

    try {
      fs.writeFileSync(filepath, JSON.stringify(resultado, null, 2));

      // Agregar al historial
      this.history.unshift({
        id: resultado.id,
        timestamp: resultado.timestamp,
        tipo: resultado.tipo,
        resumen: resultado.resumen,
        filepath
      });

      // Mantener solo últimos 30 reportes en historial
      if (this.history.length > 30) {
        this.history = this.history.slice(0, 30);
      }

      logger.info(`📄 Reporte guardado: ${filename}`);

    } catch (error) {
      logger.error(`Error guardando reporte: ${error.message}`);
    }
  }

  /**
   * Obtiene un reporte por ID
   * @param {string} reportId - ID del reporte
   * @returns {Object|null} Reporte o null si no existe
   */
  obtenerReporte(reportId) {
    const filename = `reconciliation-${reportId}.json`;
    const filepath = path.join(this.reportsDir, filename);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      logger.error(`Error leyendo reporte ${reportId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Lista todos los reportes disponibles
   * @returns {Array} Lista de reportes
   */
  listarReportes() {
    try {
      const files = fs.readdirSync(this.reportsDir)
        .filter(f => f.startsWith('reconciliation-') && f.endsWith('.json'))
        .sort()
        .reverse();

      return files.map(filename => {
        const filepath = path.join(this.reportsDir, filename);
        const stats = fs.statSync(filepath);

        return {
          id: filename.replace('reconciliation-', '').replace('.json', ''),
          filename,
          createdAt: stats.mtime.toISOString(),
          size: stats.size
        };
      });
    } catch (error) {
      logger.error(`Error listando reportes: ${error.message}`);
      return [];
    }
  }

  /**
   * Obtiene el historial de reconciliaciones
   * @returns {Array} Historial
   */
  getHistory() {
    return this.history;
  }

  /**
   * Genera ID único para reporte
   * @private
   */
  _generarReporteId() {
    const now = new Date();
    const timestamp = now.toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .split('.')[0];
    const random = Math.random().toString(36).substring(2, 6);
    return `${timestamp}-${random}`;
  }

  /**
   * Delay helper
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton
let instance = null;

function getReconciliationService(options = {}) {
  if (!instance) {
    instance = new ReconciliationService(options);
  }
  return instance;
}

module.exports = {
  ReconciliationService,
  getReconciliationService,
  DISCREPANCY_TYPES,
  SEVERITY
};
