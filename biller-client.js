/**
 * Cliente para API de Biller
 * Con reintentos, timeout y manejo robusto de errores
 * @module biller-client
 */

const config = require('./config');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');
const { 
  validarRUT, 
  extraerRUTDePedido, 
  validarDatosComprobante,
  sanitizarString 
} = require('./utils/validators');

/**
 * Error personalizado para errores de Biller
 */
class BillerError extends Error {
  constructor(message, code, status, response) {
    super(message);
    this.name = 'BillerError';
    this.code = code;
    this.status = status;
    this.response = response;
  }
}

/**
 * Cliente para la API de Biller
 */
class BillerClient {
  constructor() {
    this.baseUrl = config.biller.baseUrl;
    this.token = config.biller.token;
    this.empresaId = config.biller.empresa.id;
    this.timeout = config.biller.timeout;
    this.retryConfig = config.biller.retry;
  }

  /**
   * Realizar petición HTTP con timeout
   */
  async fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Realizar petición a la API de Biller
   * @param {string} method - Método HTTP
   * @param {string} endpoint - Endpoint
   * @param {Object} data - Datos a enviar
   * @param {Object} options - Opciones adicionales
   */
  async request(method, endpoint, data = null, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const startTime = Date.now();
    
    const fetchOptions = {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'ShopifyBillerIntegration/2.0'
      }
    };

    if (data) {
      fetchOptions.body = JSON.stringify(data);
    }

    logger.debug(`Biller API: ${method} ${endpoint}`, { 
      hasBody: !!data 
    });

    try {
      const response = await this.fetchWithTimeout(url, fetchOptions);
      const duration = Date.now() - startTime;
      const responseText = await response.text();
      
      logger.request(method, endpoint, response.status, duration);
      
      let responseData;
      try {
        responseData = responseText ? JSON.parse(responseText) : {};
      } catch {
        responseData = { raw: responseText };
      }

      if (!response.ok) {
        const errorMessage = responseData.message || 
                            responseData.error || 
                            responseData.errors?.join(', ') ||
                            `HTTP ${response.status}`;
        
        const error = new BillerError(
          errorMessage,
          responseData.code || 'UNKNOWN_ERROR',
          response.status,
          responseData
        );
        
        throw error;
      }

      return responseData;
      
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new BillerError('Request timeout', 'TIMEOUT', 0, null);
      }
      
      if (error instanceof BillerError) {
        throw error;
      }
      
      // Error de red
      logger.error('Error de conexión con Biller', { 
        error: error.message, 
        endpoint 
      });
      
      const netError = new BillerError(
        `Error de conexión: ${error.message}`,
        'NETWORK_ERROR',
        0,
        null
      );
      netError.originalError = error;
      throw netError;
    }
  }

  /**
   * Request con reintentos automáticos
   */
  async requestWithRetry(method, endpoint, data = null, operationName = 'biller-request') {
    return withRetry(
      () => this.request(method, endpoint, data),
      {
        ...this.retryConfig,
        operationName
      }
    );
  }

  /**
   * Verificar conexión con Biller
   * Intenta varios endpoints para confirmar que la API responde
   */
  async verificarConexion() {
    try {
      // Primero intentar endpoint de empresas
      try {
        const response = await this.request('GET', `/empresas/${this.empresaId}`);
        return {
          connected: true,
          empresa: response.nombre || response.razon_social || config.biller.empresa.nombre,
          rut: response.rut,
          ambiente: config.biller.environment,
          timestamp: new Date().toISOString()
        };
      } catch (empresaError) {
        // Si /empresas falla, intentar un request simple para verificar conectividad
        // Esto es normal en ambiente test donde /empresas puede no existir
        logger.debug('Endpoint /empresas no disponible, verificando conectividad básica');
        
        // Intentar endpoint de comprobantes (solo para verificar auth)
        try {
          await this.request('GET', '/comprobantes?limit=1');
          return {
            connected: true,
            empresa: config.biller.empresa.nombre,
            ambiente: config.biller.environment,
            timestamp: new Date().toISOString(),
            note: 'Conexión verificada (endpoint empresas no disponible)'
          };
        } catch (compError) {
          // Si también falla, verificar si es error de auth o de red
          if (compError.status === 401 || compError.status === 403) {
            return {
              connected: false,
              error: 'Token de Biller inválido o expirado',
              ambiente: config.biller.environment,
              timestamp: new Date().toISOString()
            };
          }
          // Asumir conectado si llegamos aquí (puede ser 404 u otro)
          return {
            connected: true,
            empresa: config.biller.empresa.nombre,
            ambiente: config.biller.environment,
            timestamp: new Date().toISOString(),
            warning: 'No se pudo verificar completamente'
          };
        }
      }
    } catch (error) {
      return {
        connected: false,
        error: error.message,
        code: error.code,
        ambiente: config.biller.environment,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Validar RUT con DGI a través de Biller
   * @param {string} rut - RUT a validar (12 dígitos)
   */
  async validarRUTConDGI(rut) {
    const rutLimpio = String(rut).replace(/\D/g, '');
    
    // Validación local primero
    const validacionLocal = validarRUT(rutLimpio);
    if (!validacionLocal.valid) {
      return {
        valid: false,
        reason: validacionLocal.reason,
        source: 'local'
      };
    }

    // Solo RUT de 12 dígitos se validan con DGI
    if (rutLimpio.length !== 12) {
      return {
        valid: true,
        type: 'CI',
        source: 'local',
        reason: 'CI validado localmente (DGI no valida CI)'
      };
    }

    try {
      const response = await this.requestWithRetry(
        'GET', 
        `/utils/validar-rut/${rutLimpio}`,
        null,
        'validar-rut-dgi'
      );
      
      return {
        valid: response.valido === true,
        razonSocial: response.RazonSocial || response.razon_social || null,
        data: response,
        source: 'dgi'
      };
    } catch (error) {
      logger.warn('Error consultando DGI', { rut: rutLimpio, error: error.message });
      
      // Si falla DGI, aceptar validación local
      return {
        valid: true,
        warning: true,
        reason: `No se pudo verificar con DGI: ${error.message}`,
        source: 'local-fallback'
      };
    }
  }

  /**
   * Emitir comprobante fiscal electrónico
   * @param {Object} datos - Datos del comprobante
   */
  async emitirComprobante(datos) {
    const sucursalId = parseInt(datos.sucursal || config.biller.empresa.sucursal, 10);
    if (!sucursalId) {
      throw new BillerError(
        'Sucursal no configurada (BILLER_EMPRESA_SUCURSAL)',
        'CONFIG_ERROR',
        400,
        null
      );
    }

    // Limpiar campos no soportados y aplicar defaults requeridos por v2
    const {
      emailCliente, // se usa sólo para envío posterior
      id_externo,   // v2 no soporta id_externo
      empresa_id,   // no requerido en v2 (token ya identifica empresa)
      ...rest
    } = datos;

    const datosCompletos = {
      moneda: 'UYU',
      montos_brutos: 0,
      forma_pago: datos.forma_pago || 1,
      numero_interno: datos.numero_interno || datos.numero_orden || `shopify-${Date.now()}`,
      sucursal: sucursalId,
      ...rest
    };

    const validacion = validarDatosComprobante(datosCompletos);
    if (!validacion.valid) {
      throw new BillerError(
        `Datos de comprobante inválidos: ${validacion.errors.join(', ')}`,
        'VALIDATION_ERROR',
        400,
        { errors: validacion.errors }
      );
    }

    const tipoStr = this.getTipoComprobanteStr(datos.tipo_comprobante);
    logger.info(`Emitiendo ${tipoStr}`, { 
      tipo: datos.tipo_comprobante,
      items: datos.items?.length,
      cliente: datos.cliente?.razon_social || datos.cliente?.nombre_fantasia || 'Consumidor final',
      numero_interno: datosCompletos.numero_interno
    });

    const response = await this.requestWithRetry(
      'POST', 
      '/comprobantes/crear', 
      datosCompletos,
      `emitir-${tipoStr.toLowerCase().replace(' ', '-')}`
    );
    
    logger.info(`✅ ${tipoStr} emitido exitosamente`, {
      id: response.id,
      serie: response.serie,
      numero: response.numero,
      cae: response.cae_numero
    });

    // Log de envío de email
    if (datosCompletos.emails_notificacion && datosCompletos.emails_notificacion.length > 0) {
      logger.info(`📧 Email con PDF será enviado por Biller a: ${datosCompletos.emails_notificacion.join(', ')}`);
    } else {
      logger.warn('⚠️ No se enviará email: pedido sin dirección de email');
    }

    return {
      id: response.id,
      serie: response.serie,
      numero: response.numero,
      cae_numero: response.cae_numero,
      cae_rango: response.cae_rango,
      cae_vencimiento: response.cae_vencimiento,
      tipo_comprobante: datos.tipo_comprobante,
      fecha_emision: response.fecha_emision || new Date().toISOString(),
      url: response.url,
      pdfUrl: `${this.baseUrl}/comprobantes/${response.id}/pdf`,
      qr: response.qr
    };
  }

  /**
   * Anular comprobante creando automáticamente una NC
   * Usa el endpoint /v2/comprobantes/anular que crea una NC completa
   * @param {Object} params - Parámetros de anulación
   * @param {number} params.id - ID del comprobante a anular (opcional si se usa tipo/serie/numero)
   * @param {number} params.tipo_comprobante - Tipo del comprobante (opcional si se usa id)
   * @param {string} params.serie - Serie del comprobante (opcional si se usa id)
   * @param {number} params.numero - Número del comprobante (opcional si se usa id)
   * @param {boolean} params.fecha_emision_hoy - Si true, la NC tiene fecha de hoy
   */
  async anularComprobante(params) {
    const { id, tipo_comprobante, serie, numero, fecha_emision_hoy = true } = params;

    // Validar que tengamos identificación del comprobante
    if (!id && !(tipo_comprobante && serie && numero)) {
      throw new BillerError(
        'Debe proporcionar id o tipo_comprobante+serie+numero',
        'VALIDATION_ERROR',
        400,
        null
      );
    }

    const datos = {
      fecha_emision_hoy: fecha_emision_hoy ? 1 : 0
    };

    if (id) {
      datos.id = id;
    } else {
      datos.tipo_comprobante = tipo_comprobante;
      datos.serie = serie;
      datos.numero = parseInt(numero, 10);
    }

    logger.info('Anulando comprobante', {
      id: datos.id,
      tipo: datos.tipo_comprobante,
      serie: datos.serie,
      numero: datos.numero
    });

    const response = await this.requestWithRetry(
      'POST',
      '/comprobantes/anular',
      datos,
      'anular-comprobante'
    );

    logger.info('✅ Comprobante anulado exitosamente', {
      ncId: response.id,
      ncTipo: response.tipo_comprobante,
      ncSerie: response.serie,
      ncNumero: response.numero
    });

    return {
      id: response.id,
      tipo_comprobante: response.tipo_comprobante,
      serie: response.serie,
      numero: response.numero,
      hash: response.hash,
      fecha_emision: response.fecha_emision,
      pdfUrl: `${this.baseUrl}/comprobantes/${response.id}/pdf`
    };
  }

  getTipoComprobanteStr(tipo) {
    const tipos = {
      101: 'e-Ticket',
      102: 'NC e-Ticket',
      103: 'ND e-Ticket',
      111: 'e-Factura',
      112: 'NC e-Factura',
      113: 'ND e-Factura'
    };
    return tipos[tipo] || `CFE ${tipo}`;
  }

  /**
   * Obtener PDF del comprobante
   * @param {string|number} comprobanteId
   */
  async obtenerPDF(comprobanteId) {
    const url = `${this.baseUrl}/comprobantes/${comprobanteId}/pdf`;
    
    try {
      const response = await this.fetchWithTimeout(url, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      if (!response.ok) {
        throw new BillerError(
          `Error obteniendo PDF: ${response.status}`,
          'PDF_ERROR',
          response.status,
          null
        );
      }

      return await response.arrayBuffer();
    } catch (error) {
      if (error instanceof BillerError) throw error;
      throw new BillerError(`Error obteniendo PDF: ${error.message}`, 'PDF_ERROR', 0, null);
    }
  }

  /**
   * Enviar comprobante por email
   * @param {string|number} comprobanteId
   * @param {string} email
   * @param {Object} opciones
   */
  async enviarComprobantePorEmail(comprobanteId, email, opciones = {}) {
    return this.requestWithRetry(
      'POST', 
      `/comprobantes/${comprobanteId}/enviar`,
      {
        email,
        asunto: opciones.asunto,
        mensaje: opciones.mensaje
      },
      'enviar-email'
    );
  }

  /**
   * Buscar comprobante por número interno (usado como id de Shopify)
   * @param {string} numeroInterno
   */
  async buscarPorNumeroInterno(numeroInterno) {
    try {
      const response = await this.request(
        'GET', 
        `/comprobantes?numero_interno=${encodeURIComponent(numeroInterno)}`
      );
      
      // La API puede devolver array o objeto con data
      const comprobantes = response.data || response;
      
      if (Array.isArray(comprobantes) && comprobantes.length > 0) {
        return comprobantes[0];
      }
      
      return null;
    } catch (error) {
      logger.debug('Error buscando comprobante', { numeroInterno, error: error.message });
      return null;
    }
  }

  /**
   * Obtener comprobante por ID
   * @param {string|number} id
   */
  async obtenerComprobante(id) {
    return this.request('GET', `/comprobantes/${id}`);
  }

  /**
   * Listar comprobantes con filtros
   * @param {Object} filtros
   */
  async listarComprobantes(filtros = {}) {
    const params = new URLSearchParams();
    
    if (filtros.desde) params.append('desde', filtros.desde);
    if (filtros.hasta) params.append('hasta', filtros.hasta);
    if (filtros.tipo) params.append('tipo_comprobante', filtros.tipo);
    if (filtros.limite) params.append('limit', filtros.limite);
    if (filtros.pagina) params.append('page', filtros.pagina);
    
    const query = params.toString();
    return this.request('GET', `/comprobantes${query ? '?' + query : ''}`);
  }
}

// ============================================================
// CONVERSIÓN SHOPIFY → BILLER
// ============================================================

/**
 * Convertir pedido de Shopify a formato Biller
 * @param {Object} order - Pedido de Shopify
 * @returns {Object} - Datos para crear comprobante en Biller
 */
function shopifyOrderToBiller(order) {
  // 1. Extraer RUT si existe
  const { rut, razonSocial, source } = extraerRUTDePedido(order);
  
  // 2. Determinar tipo de comprobante y preparar cliente
 let tipoComprobante = config.TIPOS_CFE.E_TICKET;
  let cliente = null;
  const emailNotificacion = order.email || order.customer?.email || null;

  if (rut) {
    const validacion = validarRUT(rut);
    const rutLimpio = validacion.cleaned || rut;
    
    if (validacion.valid || validacion.needsVerification) {
      tipoComprobante = config.TIPOS_CFE.E_FACTURA;
      
      cliente = {
        tipo_documento: rutLimpio.length === 12 ? config.TIPOS_DOCUMENTO.RUT : config.TIPOS_DOCUMENTO.CI,
        documento: rutLimpio,
        razon_social: sanitizarString(razonSocial || 'Cliente', 70),
        nombre_fantasia: sanitizarString(razonSocial || 'Cliente', 70),
        informacion_adicional: sanitizarString(order.note || '', 150),
        sucursal: {
          pais: 'UY'
        }
      };
      
      const direccion = order.billing_address || order.shipping_address;
      if (direccion) {
        cliente.sucursal.direccion = sanitizarString(
          [direccion.address1, direccion.address2].filter(Boolean).join(' '),
          70
        );
        if (direccion.city) cliente.sucursal.ciudad = sanitizarString(direccion.city, 30);
        if (direccion.province) cliente.sucursal.departamento = sanitizarString(direccion.province, 30);
      }
      
      if (emailNotificacion) {
        cliente.sucursal.emails = [emailNotificacion];
      }
      
      logger.info('RUT detectado, emitiendo e-Factura', { 
        rut: rutLimpio,
        tipo: validacion.type,
        source,
        razonSocial: cliente.razon_social,
        needsVerification: validacion.needsVerification || false
      });
    } else {
      logger.warn('RUT con formato inválido, emitiendo e-Ticket', { 
        rut, 
        reason: validacion.reason 
      });
    }
  } else {
    logger.info('Sin RUT, emitiendo e-Ticket');
  }

  // 3. Convertir items
  const items = [];
  
  for (const lineItem of (order.line_items || [])) {
    const precioUnitario = parseFloat(lineItem.price) || 0;
    const cantidad = parseInt(lineItem.quantity) || 1;
    
    // Determinar indicador de IVA
    let indicadorIVA = config.INDICADORES_IVA.GRAVADO_BASICA; // 22% por defecto
    
    if (lineItem.tax_lines?.length === 0 || lineItem.taxable === false) {
      indicadorIVA = config.INDICADORES_IVA.EXENTO;
    } else if (lineItem.tax_lines?.some(t => t.rate === 0.10)) {
      indicadorIVA = config.INDICADORES_IVA.GRAVADO_MINIMA; // 10%
    }

    const item = {
      cantidad,
      concepto: sanitizarString(lineItem.title || 'Producto', 80),
      descripcion: sanitizarString(
        lineItem.variant_title 
          ? `${lineItem.title} - ${lineItem.variant_title}` 
          : lineItem.title,
        200
      ),
      precio: precioUnitario,
      indicador_facturacion: indicadorIVA,
      unidad_medida: 'UN'
    };

    if (lineItem.sku) {
      item.codigo = sanitizarString(lineItem.sku, 35);
    }

    items.push(item);
  }

  // 4. Agregar envío si existe
  const shippingTotal = (order.shipping_lines || [])
    .reduce((sum, line) => sum + (parseFloat(line.price) || 0), 0);
  
  if (shippingTotal > 0) {
    items.push({
      concepto: 'Envío',
      descripcion: sanitizarString(
        order.shipping_lines?.[0]?.title || 'Costo de envío',
        200
      ),
      cantidad: 1,
      precio: shippingTotal,
      indicador_facturacion: config.INDICADORES_IVA.GRAVADO_BASICA,
      unidad_medida: 'SV' // Servicio
    });
  }

  // 5. Manejar descuentos
  const discountTotal = Math.abs(parseFloat(order.total_discounts) || 0);
  if (discountTotal > 0) {
    const discountCodes = order.discount_codes?.map(d => d.code).join(', ');
    
    items.push({
      concepto: 'Descuento',
      descripcion: sanitizarString(discountCodes || 'Descuento aplicado', 200),
      cantidad: 1,
      precio: -discountTotal,
      indicador_facturacion: config.INDICADORES_IVA.GRAVADO_BASICA,
      unidad_medida: 'UN'
    });
  }

  // 6. Construir objeto final
  const billerData = {
    tipo_comprobante: tipoComprobante,
    items,
    forma_pago: determinarFormaPago(order),
    sucursal: config.biller.empresa.sucursal ? parseInt(config.biller.empresa.sucursal) : undefined,
    moneda: 'UYU',
    montos_brutos: 0,
    numero_interno: `shopify-${order.id}`,
    numero_orden: order.name || `#${order.order_number}`,
    informacion_adicional: sanitizarString(
      `Pedido Shopify ${order.name || '#' + order.order_number}`,
      150
    ),
    emails_notificacion: emailNotificacion ? [emailNotificacion] : undefined
  };

  // Agregar cliente si es e-Factura
  if (cliente) {
    billerData.cliente = cliente;
  }

  // Email para envío de comprobante (no se envía a Biller, sólo para re-envío)
  billerData.emailCliente = emailNotificacion;

  return billerData;
}

/**
 * Determinar forma de pago desde pedido de Shopify
 * @param {Object} order
 */
function determinarFormaPago(order) {
  const status = (order.financial_status || '').toLowerCase();
  if (status && !['paid', 'authorized', 'partially_paid'].includes(status)) {
    return 2; // Crédito si no está pago aún
  }
  return 1; // Contado por defecto según v2
}

/**
 * Convertir reembolso de Shopify a items para Nota de Crédito
 * @param {Object} refund - Reembolso de Shopify
 * @param {Object} originalOrder - Pedido original (opcional)
 */
function shopifyRefundToNCItems(refund, originalOrder = null) {
  const items = [];
  
  // Items del reembolso
  if (refund.refund_line_items?.length > 0) {
    for (const refundItem of refund.refund_line_items) {
      const lineItem = refundItem.line_item;
      if (!lineItem) continue;
      
      const precio = parseFloat(lineItem.price) || 0;
      const cantidad = parseInt(refundItem.quantity) || 1;
      
      items.push({
        concepto: sanitizarString(lineItem.title || 'Producto', 80),
        descripcion: sanitizarString(`Devolución: ${lineItem.title || 'Producto'}`, 200),
        cantidad,
        precio: precio,
        indicador_facturacion: lineItem.taxable === false 
          ? config.INDICADORES_IVA.EXENTO 
          : config.INDICADORES_IVA.GRAVADO_BASICA,
        unidad_medida: 'UN'
      });
    }
  }

  // Ajustes del reembolso (shipping refund, etc.)
  if (refund.order_adjustments?.length > 0) {
    for (const adj of refund.order_adjustments) {
      const amount = parseFloat(adj.amount) || 0;
      if (amount === 0) continue;
      
      items.push({
        concepto: sanitizarString(adj.kind || 'Ajuste', 80),
        descripcion: sanitizarString(adj.reason || 'Ajuste de reembolso', 200),
        cantidad: 1,
        precio: Math.abs(amount),
        indicador_facturacion: config.INDICADORES_IVA.GRAVADO_BASICA,
        unidad_medida: 'UN'
      });
    }
  }

  // Si no hay items pero hay transacciones de reembolso
  if (items.length === 0 && refund.transactions?.length > 0) {
    const totalRefund = refund.transactions
      .filter(t => t.kind === 'refund' && t.status === 'success')
      .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
    
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

module.exports = {
  BillerClient,
  BillerError,
  shopifyOrderToBiller,
  shopifyRefundToNCItems,
  determinarFormaPago
};
