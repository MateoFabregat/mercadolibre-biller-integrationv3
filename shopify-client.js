/**
 * Cliente para API de Shopify
 * @module shopify-client
 */

const crypto = require('crypto');
const config = require('./config');
const logger = require('./utils/logger');
const { withRetry } = require('./utils/retry');

/**
 * Error personalizado para Shopify
 */
class ShopifyError extends Error {
  constructor(message, code, status, response) {
    super(message);
    this.name = 'ShopifyError';
    this.code = code;
    this.status = status;
    this.response = response;
  }
}

/**
 * Cliente para la API de Shopify
 */
class ShopifyClient {
  constructor() {
    this.shopDomain = config.shopify.shopDomain;
    this.apiKey = config.shopify.apiKey;
    this.apiSecret = config.shopify.apiSecret;
    this.accessToken = config.shopify.accessToken;
    this.apiVersion = config.shopify.apiVersion;
  }

  /**
   * URL base de la API
   */
  get baseUrl() {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}`;
  }

  /**
   * Realizar petición a la API de Shopify
   */
  async request(method, endpoint, data = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const startTime = Date.now();
    
    const options = {
      method,
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      const duration = Date.now() - startTime;
      
      // Log rate limiting
      const rateLimitHeader = response.headers.get('X-Shopify-Shop-Api-Call-Limit');
      if (rateLimitHeader) {
        const [used, max] = rateLimitHeader.split('/').map(Number);
        if (used > max * 0.8) {
          logger.warn('Shopify API rate limit alto', { used, max });
        }
      }

      logger.request(method, endpoint, response.status, duration);

      if (!response.ok) {
        const errorText = await response.text();
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { message: errorText };
        }
        
        throw new ShopifyError(
          errorData.errors || errorData.error || `HTTP ${response.status}`,
          'API_ERROR',
          response.status,
          errorData
        );
      }

      const text = await response.text();
      return text ? JSON.parse(text) : {};
      
    } catch (error) {
      if (error instanceof ShopifyError) throw error;
      
      throw new ShopifyError(
        `Error de conexión: ${error.message}`,
        'NETWORK_ERROR',
        0,
        null
      );
    }
  }

  /**
   * Request con reintentos
   */
  async requestWithRetry(method, endpoint, data = null, operationName = 'shopify-request') {
    return withRetry(
      () => this.request(method, endpoint, data),
      {
        maxAttempts: 3,
        initialDelay: 1000,
        maxDelay: 5000,
        operationName
      }
    );
  }

  // ============================================================
  // OAUTH
  // ============================================================

  /**
   * Generar URL de autorización OAuth
   */
  getAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.apiKey,
      scope: config.shopify.scopes,
      redirect_uri: redirectUri,
      state: state
    });

    return `https://${this.shopDomain}/admin/oauth/authorize?${params}`;
  }

  /**
   * Intercambiar código por Access Token
   */
  async exchangeCodeForToken(code) {
    const url = `https://${this.shopDomain}/admin/oauth/access_token`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.apiKey,
        client_secret: this.apiSecret,
        code
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ShopifyError(`Error en OAuth: ${error}`, 'OAUTH_ERROR', response.status, null);
    }

    const data = await response.json();
    this.accessToken = data.access_token;
    
    return data.access_token;
  }

  /**
   * Verificar firma HMAC de webhook
   */
  verifyWebhookHMAC(data, hmacHeader) {
    if (!hmacHeader || !data) return false;
    
    const hash = crypto
      .createHmac('sha256', this.apiSecret)
      .update(data, 'utf8')
      .digest('base64');
    
    try {
      return crypto.timingSafeEqual(
        Buffer.from(hash),
        Buffer.from(hmacHeader)
      );
    } catch {
      return false;
    }
  }

  // ============================================================
  // WEBHOOKS
  // ============================================================

  /**
   * Configurar webhooks requeridos
   */
  async setupWebhooks() {
    const webhookUrl = `${config.server.publicUrl}${config.server.webhookPath}`;
    
    const webhooksRequeridos = [
      { topic: 'orders/paid', address: webhookUrl },
      { topic: 'refunds/create', address: webhookUrl }
    ];

    logger.info('Configurando webhooks', { url: webhookUrl });

    // Obtener webhooks existentes
    const existentes = await this.getWebhooks();
    const resultados = [];

    for (const webhook of webhooksRequeridos) {
      // Verificar si ya existe con la URL correcta
      const existe = existentes.find(w => 
        w.topic === webhook.topic && 
        w.address === webhook.address
      );

      if (existe) {
        resultados.push({ 
          topic: webhook.topic, 
          status: 'exists', 
          id: existe.id 
        });
        continue;
      }

      // Eliminar webhooks viejos del mismo topic
      const viejos = existentes.filter(w => w.topic === webhook.topic);
      for (const viejo of viejos) {
        try {
          await this.deleteWebhook(viejo.id);
          logger.debug('Webhook viejo eliminado', { topic: viejo.topic, id: viejo.id });
        } catch (e) {
          logger.warn('Error eliminando webhook', { error: e.message });
        }
      }

      // Crear nuevo webhook
      try {
        const creado = await this.createWebhook(webhook.topic, webhook.address);
        logger.info(`Webhook creado: ${webhook.topic}`, { id: creado.id });
        resultados.push({ 
          topic: webhook.topic, 
          status: 'created', 
          id: creado.id 
        });
      } catch (error) {
        logger.error(`Error creando webhook ${webhook.topic}`, { error: error.message });
        resultados.push({ 
          topic: webhook.topic, 
          status: 'error', 
          error: error.message 
        });
      }
    }

    return resultados;
  }

  /**
   * Obtener todos los webhooks
   */
  async getWebhooks() {
    const response = await this.request('GET', '/webhooks.json');
    return response.webhooks || [];
  }

  /**
   * Crear webhook
   */
  async createWebhook(topic, address) {
    const response = await this.request('POST', '/webhooks.json', {
      webhook: {
        topic,
        address,
        format: 'json'
      }
    });
    return response.webhook;
  }

  /**
   * Eliminar webhook
   */
  async deleteWebhook(webhookId) {
    await this.request('DELETE', `/webhooks/${webhookId}.json`);
  }

  /**
   * Verificar estado de webhooks
   */
  async verificarWebhooks() {
    const webhooksRequeridos = ['orders/paid', 'refunds/create'];
    const webhookUrl = `${config.server.publicUrl}${config.server.webhookPath}`;
    
    const existentes = await this.getWebhooks();
    
    const configurados = [];
    const faltantes = [];
    const incorrectos = [];

    for (const topic of webhooksRequeridos) {
      const existe = existentes.find(w => w.topic === topic);
      
      if (!existe) {
        faltantes.push(topic);
      } else if (existe.address !== webhookUrl) {
        incorrectos.push({ 
          topic, 
          actual: existe.address, 
          esperado: webhookUrl 
        });
      } else {
        configurados.push({ topic, id: existe.id });
      }
    }

    return {
      url: webhookUrl,
      configurados,
      faltantes,
      incorrectos,
      todos: existentes,
      ok: faltantes.length === 0 && incorrectos.length === 0
    };
  }

  // ============================================================
  // PEDIDOS
  // ============================================================

  /**
   * Obtener un pedido por ID
   */
  async getOrder(orderId) {
    const response = await this.requestWithRetry(
      'GET', 
      `/orders/${orderId}.json`,
      null,
      'get-order'
    );
    return response.order;
  }

  /**
   * Obtener pedidos pagados pendientes de facturar
   */
  async getOrdersPendientesFacturar(limit = 50) {
    const response = await this.request(
      'GET', 
      `/orders.json?status=any&financial_status=paid&limit=${limit}`
    );
    
    const orders = response.orders || [];
    
    // Filtrar los que no tienen tag 'facturado'
    return orders.filter(order => {
      const tags = (order.tags || '').toLowerCase().split(',').map(t => t.trim());
      return !tags.includes('facturado');
    });
  }

  /**
   * Marcar pedido como facturado
   */
  async marcarComoFacturado(orderId, datosComprobante) {
    // Obtener pedido actual
    const order = await this.getOrder(orderId);
    const tagsActuales = order.tags 
      ? order.tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    
    // Agregar tag si no existe
    if (!tagsActuales.includes('facturado')) {
      tagsActuales.push('facturado');
    }

    // Actualizar tags
    await this.requestWithRetry(
      'PUT', 
      `/orders/${orderId}.json`,
      {
        order: {
          id: orderId,
          tags: tagsActuales.join(', ')
        }
      },
      'marcar-facturado'
    );

    // Guardar metafields
    const metafields = [
      { key: 'comprobante_id', value: String(datosComprobante.id) },
      { key: 'comprobante_numero', value: `${datosComprobante.serie}-${datosComprobante.numero}` },
      { key: 'comprobante_cae', value: datosComprobante.cae_numero || '' },
      { key: 'tipo_comprobante', value: String(datosComprobante.tipo_comprobante) },
      { key: 'comprobante_pdf_url', value: datosComprobante.publicPdfUrl || '' }
    ];

    for (const mf of metafields) {
      try {
        await this.request('POST', `/orders/${orderId}/metafields.json`, {
          metafield: {
            namespace: 'biller',
            key: mf.key,
            value: mf.value,
            type: 'single_line_text_field'
          }
        });
      } catch (e) {
        logger.debug('Error guardando metafield', { key: mf.key, error: e.message });
      }
    }

    logger.info('Pedido marcado como facturado', { 
      orderId, 
      comprobante: `${datosComprobante.serie}-${datosComprobante.numero}` 
    });
  }

  /**
   * Agregar nota con información del comprobante
   */
  async agregarNotaComprobante(orderId, datosComprobante) {
    const tipoStr = datosComprobante.tipo_comprobante === 111 ? 'e-Factura' : 
                    datosComprobante.tipo_comprobante === 112 ? 'NC e-Factura' :
                    datosComprobante.tipo_comprobante === 102 ? 'NC e-Ticket' : 'e-Ticket';
    
    const nota = [
      `✅ ${tipoStr} emitido`,
      `Número: ${datosComprobante.serie}-${datosComprobante.numero}`,
      `CAE: ${datosComprobante.cae_numero || 'N/A'}`,
      datosComprobante.pdfUrl ? `PDF: ${datosComprobante.pdfUrl}` : null
    ].filter(Boolean).join('\n');

    // Obtener pedido para mantener nota existente
    const order = await this.getOrder(orderId);
    const notaExistente = order.note || '';
    
    const nuevaNota = notaExistente 
      ? `${notaExistente}\n\n--- Facturación ---\n${nota}`
      : nota;

    await this.request('PUT', `/orders/${orderId}.json`, {
      order: {
        id: orderId,
        note: nuevaNota
      }
    });
  }

  /**
   * Obtener reembolsos de un pedido
   */
  async getRefunds(orderId) {
    const response = await this.request('GET', `/orders/${orderId}/refunds.json`);
    return response.refunds || [];
  }
}

module.exports = { 
  ShopifyClient,
  ShopifyError
};
