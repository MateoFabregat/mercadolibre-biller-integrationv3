/**
 * Billing Decision Service
 *
 * Determina el tipo de comprobante a emitir según las reglas de la DGI Uruguay.
 *
 * REGLA 5000 UI (Unidades Indexadas):
 * - Ventas mayores a 5000 UI (~30,000 UYU) requieren identificación del comprador
 * - Si el cliente tiene RUT válido → e-Factura (111)
 * - Si NO tiene RUT pero monto > 5000 UI → e-Ticket (101) con WARNING
 * - Si NO tiene RUT y monto <= 5000 UI → e-Ticket (101) normal
 *
 * @module services/billing-decision
 */

const config = require('../config');
const { validarRUT, extraerRUTDePedido } = require('../utils/validators');
const logger = require('../utils/logger');

// Valor de la UI en UYU (actualizar periódicamente)
// Fuente: https://www.bcu.gub.uy/Estadisticas-e-Indicadores/Paginas/Cotizaciones.aspx
const VALOR_UI_DEFAULT = 6.0; // Aproximado diciembre 2024

/**
 * Clase para manejar decisiones de facturación
 */
class BillingDecisionService {
  constructor(options = {}) {
    this.limiteUI = options.limiteUI || parseInt(process.env.LIMITE_UI_ETICKET) || 5000;
    this.valorUI = options.valorUI || parseFloat(process.env.VALOR_UI_UYU) || VALOR_UI_DEFAULT;
    this.limiteUYU = this.limiteUI * this.valorUI;

    // Estadísticas
    this.stats = {
      decisiones: 0,
      eTickets: 0,
      eFacturas: 0,
      eTicketsConWarning: 0,
      montoTotalProcesado: 0
    };

    logger.info('BillingDecisionService inicializado', {
      limiteUI: this.limiteUI,
      valorUI: this.valorUI,
      limiteUYU: this.limiteUYU
    });
  }

  /**
   * Actualiza el valor de la UI
   * @param {number} nuevoValor - Nuevo valor de la UI en UYU
   */
  actualizarValorUI(nuevoValor) {
    this.valorUI = nuevoValor;
    this.limiteUYU = this.limiteUI * this.valorUI;
    logger.info('Valor UI actualizado', { valorUI: this.valorUI, limiteUYU: this.limiteUYU });
  }

  /**
   * Calcula el monto neto (sin IVA) de un pedido
   * @param {Object} order - Pedido de Shopify
   * @returns {number} Monto neto en UYU
   */
  calcularMontoNeto(order) {
    const totalBruto = parseFloat(order.total_price || 0);
    const totalImpuestos = parseFloat(order.total_tax || 0);

    // El monto neto es el total menos impuestos
    // Si no hay impuestos separados, asumimos IVA incluido (22%)
    if (totalImpuestos > 0) {
      return totalBruto - totalImpuestos;
    }

    // IVA incluido: monto_neto = total / 1.22
    return totalBruto / 1.22;
  }

  /**
   * Determina si el monto supera el límite de 5000 UI
   * @param {number} montoNeto - Monto neto en UYU
   * @returns {Object} Resultado del análisis
   */
  analizarMonto(montoNeto) {
    const montoEnUI = montoNeto / this.valorUI;
    const superaLimite = montoEnUI > this.limiteUI;

    return {
      montoNeto,
      montoEnUI: Math.round(montoEnUI * 100) / 100,
      limiteUI: this.limiteUI,
      valorUI: this.valorUI,
      limiteUYU: this.limiteUYU,
      superaLimite,
      porcentajeDelLimite: Math.round((montoEnUI / this.limiteUI) * 100)
    };
  }

  /**
   * Determina el tipo de comprobante para un pedido de Shopify
   * @param {Object} order - Pedido de Shopify
   * @param {Object} options - Opciones adicionales
   * @returns {Object} Decisión de facturación
   */
  determinarTipoComprobante(order, options = {}) {
    this.stats.decisiones++;

    const orderId = order.id;
    const orderName = order.name || `#${order.order_number}`;

    // 1. Calcular monto neto
    const montoNeto = this.calcularMontoNeto(order);
    const analisisMonto = this.analizarMonto(montoNeto);
    this.stats.montoTotalProcesado += montoNeto;

    // 2. Extraer RUT del pedido
    const { rut, razonSocial, source } = extraerRUTDePedido(order);

    // 3. Validar RUT si existe
    let rutValido = false;
    let tipoDocumento = null;
    let rutLimpio = null;
    let validacionRUT = null;

    if (rut) {
      validacionRUT = validarRUT(rut);
      rutValido = validacionRUT.valid;
      rutLimpio = validacionRUT.cleaned;
      tipoDocumento = validacionRUT.type; // 'RUT' o 'CI'
    }

    // 4. Tomar decisión
    let decision;
    let tipoComprobante;
    let warnings = [];
    let requiresAction = false;

    if (rutValido) {
      // CASO 1: Tiene RUT válido → e-Factura
      tipoComprobante = config.TIPOS_CFE.E_FACTURA; // 111
      decision = 'E_FACTURA_CON_RUT';
      this.stats.eFacturas++;

      logger.info(`📄 Decisión: e-Factura para ${orderName}`, {
        orderId,
        rut: rutLimpio,
        tipoDocumento,
        razonSocial,
        source
      });

    } else if (analisisMonto.superaLimite) {
      // CASO 2: Sin RUT pero supera 5000 UI → e-Ticket con WARNING
      tipoComprobante = config.TIPOS_CFE.E_TICKET; // 101
      decision = 'E_TICKET_SIN_RUT_SUPERA_LIMITE';
      this.stats.eTickets++;
      this.stats.eTicketsConWarning++;
      requiresAction = true;

      warnings.push({
        code: 'SUPERA_LIMITE_5000_UI',
        message: `Pedido supera ${this.limiteUI} UI (${analisisMonto.montoEnUI.toFixed(2)} UI = $${montoNeto.toFixed(2)}) sin identificación del comprador`,
        severity: 'high',
        recommendation: 'Según normativa DGI, se recomienda solicitar RUT/CI al cliente para ventas mayores a 5000 UI'
      });

      logger.warn(`⚠️ Decisión: e-Ticket para ${orderName} - SUPERA LÍMITE 5000 UI sin RUT`, {
        orderId,
        montoNeto,
        montoEnUI: analisisMonto.montoEnUI,
        limiteUI: this.limiteUI,
        limiteUYU: this.limiteUYU
      });

    } else {
      // CASO 3: Sin RUT y bajo el límite → e-Ticket normal
      tipoComprobante = config.TIPOS_CFE.E_TICKET; // 101
      decision = 'E_TICKET_CONSUMIDOR_FINAL';
      this.stats.eTickets++;

      logger.info(`🧾 Decisión: e-Ticket para ${orderName}`, {
        orderId,
        montoNeto,
        montoEnUI: analisisMonto.montoEnUI,
        razon: 'Consumidor final sin RUT, monto bajo límite'
      });
    }

    // 5. Construir resultado
    const resultado = {
      // Decisión principal
      tipoComprobante,
      tipoComprobanteStr: this.getTipoComprobanteStr(tipoComprobante),
      decision,

      // Datos del cliente
      cliente: rutValido ? {
        tipoDocumento: tipoDocumento === 'RUT' ? config.TIPOS_DOCUMENTO.RUT : config.TIPOS_DOCUMENTO.CI,
        documento: rutLimpio,
        razonSocial: razonSocial || null,
        source
      } : null,

      // Análisis del monto
      analisisMonto,

      // Warnings y acciones
      warnings,
      requiresAction,

      // Metadata
      metadata: {
        orderId,
        orderName,
        email: order.email,
        processedAt: new Date().toISOString(),
        rutEncontrado: !!rut,
        rutValido,
        validacionRUT
      }
    };

    return resultado;
  }

  /**
   * Obtiene el string descriptivo del tipo de comprobante
   * @param {number} tipo - Código del tipo de comprobante
   * @returns {string} Descripción
   */
  getTipoComprobanteStr(tipo) {
    const tipos = {
      101: 'e-Ticket',
      102: 'NC e-Ticket',
      103: 'ND e-Ticket',
      111: 'e-Factura',
      112: 'NC e-Factura',
      113: 'ND e-Factura',
      121: 'e-Ticket Contingencia',
      122: 'NC e-Ticket Contingencia',
      131: 'e-Factura Contingencia',
      132: 'NC e-Factura Contingencia'
    };
    return tipos[tipo] || `Tipo ${tipo}`;
  }

  /**
   * Obtiene estadísticas del servicio
   * @returns {Object} Estadísticas
   */
  getStats() {
    return {
      ...this.stats,
      configuracion: {
        limiteUI: this.limiteUI,
        valorUI: this.valorUI,
        limiteUYU: this.limiteUYU
      },
      porcentajes: {
        eTickets: this.stats.decisiones > 0
          ? Math.round((this.stats.eTickets / this.stats.decisiones) * 100)
          : 0,
        eFacturas: this.stats.decisiones > 0
          ? Math.round((this.stats.eFacturas / this.stats.decisiones) * 100)
          : 0,
        conWarning: this.stats.eTickets > 0
          ? Math.round((this.stats.eTicketsConWarning / this.stats.eTickets) * 100)
          : 0
      }
    };
  }

  /**
   * Reinicia las estadísticas
   */
  resetStats() {
    this.stats = {
      decisiones: 0,
      eTickets: 0,
      eFacturas: 0,
      eTicketsConWarning: 0,
      montoTotalProcesado: 0
    };
  }
}

// Singleton
let instance = null;

function getBillingDecisionService(options = {}) {
  if (!instance) {
    instance = new BillingDecisionService(options);
  }
  return instance;
}

module.exports = {
  BillingDecisionService,
  getBillingDecisionService
};
