/**
 * Credit Note Service
 *
 * Maneja la lógica de generación de Notas de Crédito para reembolsos.
 *
 * Tipos de NC según el comprobante original:
 * - Si original fue e-Ticket (101) → NC e-Ticket (102)
 * - Si original fue e-Factura (111) → NC e-Factura (112)
 *
 * @module services/credit-note-service
 */

const config = require('../config');
const logger = require('../utils/logger');

/**
 * Clase para manejar notas de crédito
 */
class CreditNoteService {
  constructor(options = {}) {
    this.billerClient = options.billerClient || null;
    this.comprobanteStore = options.comprobanteStore || null;

    // Estadísticas
    this.stats = {
      ncGeneradas: 0,
      ncETicket: 0,
      ncEFactura: 0,
      errores: 0,
      montoTotalNC: 0
    };

    logger.info('CreditNoteService inicializado');
  }

  /**
   * Configura las dependencias del servicio
   */
  configure(options) {
    if (options.billerClient) this.billerClient = options.billerClient;
    if (options.comprobanteStore) this.comprobanteStore = options.comprobanteStore;
  }

  /**
   * Determina el tipo de NC según el comprobante original
   * @param {number} tipoOriginal - Tipo del comprobante original
   * @returns {number} Tipo de NC correspondiente
   */
  determinarTipoNC(tipoOriginal) {
    // e-Factura y sus variantes → NC e-Factura (112)
    if ([111, 112, 113, 131, 132, 133].includes(tipoOriginal)) {
      return config.TIPOS_CFE.NC_E_FACTURA; // 112
    }

    // e-Ticket y sus variantes → NC e-Ticket (102)
    return config.TIPOS_CFE.NC_E_TICKET; // 102
  }

  /**
   * Obtiene el string descriptivo del tipo de NC
   * @param {number} tipo - Código del tipo
   * @returns {string} Descripción
   */
  getTipoNCStr(tipo) {
    const tipos = {
      102: 'NC e-Ticket',
      112: 'NC e-Factura',
      122: 'NC e-Ticket Contingencia',
      132: 'NC e-Factura Contingencia'
    };
    return tipos[tipo] || `NC Tipo ${tipo}`;
  }

  /**
   * Convierte items del reembolso de Shopify a formato Biller
   * @param {Object} refund - Objeto de reembolso de Shopify
   * @param {Object} originalOrder - Pedido original (opcional)
   * @returns {Array} Items en formato Biller
   */
  convertirItemsRefund(refund, originalOrder = null) {
    const items = [];

    // 1. Items del reembolso (productos devueltos)
    if (refund.refund_line_items && refund.refund_line_items.length > 0) {
      for (const refundItem of refund.refund_line_items) {
        const lineItem = refundItem.line_item;

        if (!lineItem) continue;

        // Determinar indicador de IVA
        let indicadorIVA = config.INDICADORES_IVA.GRAVADO_BASICA; // 22% por defecto

        if (lineItem.taxable === false || (lineItem.tax_lines && lineItem.tax_lines.length === 0)) {
          indicadorIVA = config.INDICADORES_IVA.EXENTO;
        } else if (lineItem.tax_lines && lineItem.tax_lines.some(t => t.rate === 0.10)) {
          indicadorIVA = config.INDICADORES_IVA.GRAVADO_MINIMA; // 10%
        }

        items.push({
          concepto: lineItem.title || 'Producto',
          descripcion: `Devolución: ${lineItem.title}${lineItem.variant_title ? ` - ${lineItem.variant_title}` : ''}`,
          cantidad: refundItem.quantity,
          precio: parseFloat(lineItem.price),
          indicador_facturacion: indicadorIVA,
          unidad_medida: 'UN',
          codigo: lineItem.sku || null
        });
      }
    }

    // 2. Ajustes del reembolso (shipping, descuentos, etc.)
    if (refund.order_adjustments && refund.order_adjustments.length > 0) {
      for (const adjustment of refund.order_adjustments) {
        const amount = parseFloat(adjustment.amount || 0);

        if (amount === 0) continue;

        let concepto = 'Ajuste';
        let descripcion = adjustment.reason || 'Ajuste de reembolso';

        // Mapear tipos de ajuste
        switch (adjustment.kind) {
          case 'shipping_refund':
            concepto = 'Devolución envío';
            descripcion = 'Reembolso de costo de envío';
            break;
          case 'refund_discrepancy':
            concepto = 'Ajuste de discrepancia';
            break;
          default:
            concepto = adjustment.kind || 'Ajuste';
        }

        items.push({
          concepto,
          descripcion,
          cantidad: 1,
          precio: Math.abs(amount),
          indicador_facturacion: config.INDICADORES_IVA.GRAVADO_BASICA,
          unidad_medida: 'UN'
        });
      }
    }

    // 3. Si no hay items pero hay transacciones de reembolso
    if (items.length === 0 && refund.transactions && refund.transactions.length > 0) {
      const totalRefund = refund.transactions
        .filter(t => t.kind === 'refund' && t.status === 'success')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

      if (totalRefund > 0) {
        items.push({
          concepto: 'Devolución',
          descripcion: 'Reembolso de compra',
          cantidad: 1,
          precio: totalRefund,
          indicador_facturacion: config.INDICADORES_IVA.GRAVADO_BASICA,
          unidad_medida: 'UN'
        });
      }
    }

    return items;
  }

  /**
   * Calcula el monto total de una NC
   * @param {Array} items - Items de la NC
   * @returns {number} Monto total
   */
  calcularMontoTotal(items) {
    return items.reduce((sum, item) => {
      return sum + (item.cantidad * item.precio);
    }, 0);
  }

  /**
   * Genera los datos de una Nota de Crédito
   * @param {Object} params - Parámetros
   * @param {Object} params.refund - Objeto de reembolso de Shopify
   * @param {Object} params.comprobanteOriginal - Comprobante original
   * @param {Object} params.originalOrder - Pedido original (opcional)
   * @returns {Object} Datos de la NC lista para emitir
   */
  generarDatosNC(params) {
    const { refund, comprobanteOriginal, originalOrder } = params;

    const refundId = refund.id;
    const orderId = refund.order_id;

    // Determinar tipo de NC
    const tipoOriginal = comprobanteOriginal.tipo_comprobante;
    const tipoNC = this.determinarTipoNC(tipoOriginal);

    // Convertir items
    const items = this.convertirItemsRefund(refund, originalOrder);

    if (items.length === 0) {
      throw new Error('No se encontraron items para la nota de crédito');
    }

    // Calcular monto total
    const montoTotal = this.calcularMontoTotal(items);

    // Obtener email del cliente
    const emailCliente = originalOrder?.email || refund.user?.email || null;

    // Construir datos de la NC
    const ncData = {
      tipo_comprobante: tipoNC,
      items,
      forma_pago: 1, // Contado
      sucursal: parseInt(config.biller.empresa.sucursal),
      moneda: 'UYU',
      montos_brutos: 0,
      numero_interno: `shopify-refund-${refundId}`,
      informacion_adicional: `Nota de Crédito - Reembolso Shopify #${refundId}`,

      // Referencias al comprobante original (OBLIGATORIO para NC)
      referencias: [{
        tipo_cfe: tipoOriginal,
        serie: comprobanteOriginal.serie,
        numero: parseInt(comprobanteOriginal.numero),
        fecha: comprobanteOriginal.fecha_emision || comprobanteOriginal.created_at
      }]
    };

    // Agregar email de notificación si existe
    if (emailCliente) {
      ncData.emails_notificacion = [emailCliente];
    }

    // Si el original era e-Factura, incluir datos del cliente
    if (tipoNC === config.TIPOS_CFE.NC_E_FACTURA && comprobanteOriginal.cliente) {
      ncData.cliente = comprobanteOriginal.cliente;
    }

    logger.info(`📝 NC generada para refund ${refundId}`, {
      tipoNC: this.getTipoNCStr(tipoNC),
      tipoOriginal,
      items: items.length,
      montoTotal,
      referencias: ncData.referencias
    });

    return {
      ncData,
      metadata: {
        refundId,
        orderId,
        tipoNC,
        tipoNCStr: this.getTipoNCStr(tipoNC),
        tipoOriginal,
        montoTotal,
        itemsCount: items.length,
        comprobanteOriginalId: comprobanteOriginal.id
      }
    };
  }

  /**
   * Procesa un reembolso completo y emite la NC
   * @param {Object} params - Parámetros
   * @returns {Object} Resultado del procesamiento
   */
  async procesarReembolso(params) {
    const { refund, originalOrder, shopifyClient } = params;

    const refundId = refund.id;
    const orderId = refund.order_id;
    const orderName = originalOrder?.name || `#${originalOrder?.order_number || orderId}`;

    logger.info(`🔄 Procesando reembolso ${refundId} para pedido ${orderName}`);

    try {
      // 1. Buscar comprobante original
      let comprobanteOriginal = null;

      // Primero en store local
      if (this.comprobanteStore) {
        comprobanteOriginal = this.comprobanteStore.get(orderId);
      }

      // Si no está en local, buscar en Biller
      if (!comprobanteOriginal && this.billerClient) {
        try {
          const encontrado = await this.billerClient.buscarPorNumeroInterno(`shopify-${orderId}`);
          if (encontrado) {
            comprobanteOriginal = encontrado;
          }
        } catch (err) {
          logger.warn(`No se pudo buscar comprobante en Biller: ${err.message}`);
        }
      }

      if (!comprobanteOriginal) {
        return {
          status: 'error',
          reason: 'comprobante_original_no_encontrado',
          message: `No se encontró comprobante para el pedido ${orderId}`,
          refundId,
          orderId
        };
      }

      // 2. Generar datos de la NC
      const { ncData, metadata } = this.generarDatosNC({
        refund,
        comprobanteOriginal,
        originalOrder
      });

      // 3. Emitir NC en Biller
      if (!this.billerClient) {
        throw new Error('BillerClient no configurado');
      }

      const nc = await this.billerClient.emitirComprobante(ncData);

      // 4. Guardar en store
      if (this.comprobanteStore) {
        this.comprobanteStore.set(`refund-${refundId}`, {
          id: nc.id,
          tipo_comprobante: metadata.tipoNC,
          serie: nc.serie,
          numero: nc.numero,
          cae_numero: nc.cae_numero,
          fecha_emision: nc.fecha_emision,
          comprobante_original_id: comprobanteOriginal.id,
          refund_id: refundId,
          order_id: orderId,
          monto: metadata.montoTotal
        });
      }

      // 5. Actualizar estadísticas
      this.stats.ncGeneradas++;
      this.stats.montoTotalNC += metadata.montoTotal;

      if (metadata.tipoNC === config.TIPOS_CFE.NC_E_FACTURA) {
        this.stats.ncEFactura++;
      } else {
        this.stats.ncETicket++;
      }

      logger.info(`✅ NC emitida exitosamente`, {
        refundId,
        orderId,
        ncId: nc.id,
        serie: nc.serie,
        numero: nc.numero,
        tipo: metadata.tipoNCStr
      });

      return {
        status: 'success',
        tipo: metadata.tipoNCStr,
        notaCredito: {
          id: nc.id,
          serie: nc.serie,
          numero: nc.numero,
          cae_numero: nc.cae_numero,
          tipo_comprobante: metadata.tipoNC,
          monto: metadata.montoTotal,
          pdfUrl: nc.pdfUrl
        },
        comprobanteOriginal: {
          id: comprobanteOriginal.id,
          serie: comprobanteOriginal.serie,
          numero: comprobanteOriginal.numero,
          tipo: comprobanteOriginal.tipo_comprobante
        },
        metadata
      };

    } catch (error) {
      this.stats.errores++;

      logger.error(`❌ Error procesando reembolso ${refundId}`, {
        error: error.message,
        orderId,
        stack: error.stack
      });

      return {
        status: 'error',
        reason: 'processing_error',
        message: error.message,
        refundId,
        orderId
      };
    }
  }

  /**
   * Obtiene estadísticas del servicio
   * @returns {Object} Estadísticas
   */
  getStats() {
    return {
      ...this.stats,
      promedioMontoNC: this.stats.ncGeneradas > 0
        ? this.stats.montoTotalNC / this.stats.ncGeneradas
        : 0
    };
  }

  /**
   * Reinicia las estadísticas
   */
  resetStats() {
    this.stats = {
      ncGeneradas: 0,
      ncETicket: 0,
      ncEFactura: 0,
      errores: 0,
      montoTotalNC: 0
    };
  }
}

// Singleton
let instance = null;

function getCreditNoteService(options = {}) {
  if (!instance) {
    instance = new CreditNoteService(options);
  }
  return instance;
}

module.exports = {
  CreditNoteService,
  getCreditNoteService
};
