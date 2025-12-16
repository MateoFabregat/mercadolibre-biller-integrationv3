/**
 * ============================================================
 * SERVIDOR DE INTEGRACIÓN SHOPIFY ↔ BILLER
 * Facturación Electrónica para Uruguay
 * Versión Profesional 2.1
 * ============================================================
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const { BillerClient, shopifyOrderToBiller, shopifyRefundToNCItems } = require('./biller-client');
const { ShopifyClient } = require('./shopify-client');
const logger = require('./utils/logger');
const { getComprobanteStore, WebhookDedupeStore } = require('./utils/store');
const { validarPedidoShopify } = require('./utils/validators');
const { AsyncQueue } = require('./utils/queue');
const { CircuitBreaker } = require('./utils/circuit-breaker');

// Nuevos servicios v2.1
const { getBillingDecisionService } = require('./services/billing-decision');
const { getCreditNoteService } = require('./services/credit-note-service');
const { getReconciliationService } = require('./services/reconciliation-service');
const { getErrorStore } = require('./utils/error-store');
const { getAuditLogger } = require('./utils/audit-logger');
const { getCircuitBreaker: getCircuitBreakerV2, getAllCircuitsState } = require('./utils/circuit-breaker-v2');
const { getBillerSearchCache } = require('./utils/biller-search-cache');
const { getPDFSenderWorker } = require('./workers/pdf-sender-worker');

// ============================================================
// INICIALIZACIÓN
// ============================================================

const app = express();
const biller = new BillerClient();
const shopify = new ShopifyClient();
const comprobanteStore = getComprobanteStore();
const webhookDedupe = new WebhookDedupeStore(config.procesamiento.dedupeWindow);

// Cola de procesamiento de webhooks
const webhookQueue = new AsyncQueue({
  concurrency: config.procesamiento.maxConcurrent,
  timeout: 120000, // 2 minutos por tarea
  maxQueueSize: 200
});

// Circuit breaker para Biller
const billerCircuit = new CircuitBreaker({
  name: 'biller',
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 60000
});

// Nuevos servicios v2.1
const billingDecision = getBillingDecisionService();
const creditNoteService = getCreditNoteService();
const reconciliationService = getReconciliationService();
const errorStore = getErrorStore();
const auditLogger = getAuditLogger();
const billerCache = getBillerSearchCache();
const pdfWorker = getPDFSenderWorker();

// Configurar dependencias de servicios
creditNoteService.configure({ billerClient: biller, comprobanteStore });
reconciliationService.configure({ billerClient: biller, comprobanteStore });
pdfWorker.configure({ billerClient: biller });

// Métricas
const metrics = {
  webhooksRecibidos: 0,
  webhooksProcesados: 0,
  webhooksDuplicados: 0,
  comprobantesEmitidos: 0,
  errores: 0,
  startTime: Date.now()
};

// ============================================================
// MIDDLEWARE
// ============================================================

// Raw body para verificación HMAC
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/webhooks')) {
      logger.request(req.method, req.path, res.statusCode, Date.now() - start);
    }
  });
  next();
});

// ============================================================
// HEALTH CHECK & METRICS
// ============================================================

app.get('/', async (req, res) => {
  const status = {
    status: 'ok',
    service: 'Shopify-Biller Integration',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    environment: config.biller.environment,
    shop: config.shopify.shop,
    uptime: Math.round((Date.now() - metrics.startTime) / 1000)
  };

  if (req.query.detailed === 'true') {
    status.biller = await biller.verificarConexion();
    status.shopify = {
      configured: !!config.shopify.accessToken,
      shop: config.shopify.shopDomain
    };
    
    if (config.shopify.accessToken) {
      try {
        status.webhooks = await shopify.verificarWebhooks();
      } catch (e) {
        status.webhooks = { error: e.message };
      }
    }
    
    status.storage = {
      comprobantes: comprobanteStore.size
    };
    
    status.metrics = {
      ...metrics,
      uptime: status.uptime
    };
  }

  res.json(status);
});

app.get('/metrics', (req, res) => {
  const stats = comprobanteStore.getStats();
  const queueStatus = webhookQueue.getStatus();
  const circuitStatus = billerCircuit.getState();
  
  res.json({
    ...metrics,
    uptime: Math.round((Date.now() - metrics.startTime) / 1000),
    queue: queueStatus,
    circuit: circuitStatus,
    comprobantes: stats
  });
});

// ============================================================
// OAUTH
// ============================================================

app.get('/install', (req, res) => {
  let shop = req.query.shop || config.shopify.shopDomain;
  
  if (!shop) {
    return res.status(400).send(`
      <html><body style="font-family:system-ui;padding:40px;max-width:600px;margin:auto">
        <h1>Error: Falta el parámetro shop</h1>
        <p>Uso: <code>/install?shop=tu-tienda.myshopify.com</code></p>
      </body></html>
    `);
  }

  if (!shop.includes('.myshopify.com')) {
    shop = `${shop}.myshopify.com`;
  }

  const state = crypto.randomBytes(16).toString('hex');
  app.locals.oauthState = state;
  
  const redirectUri = `${config.server.publicUrl}/auth/callback`;
  const tempShopify = new ShopifyClient();
  tempShopify.shopDomain = shop;
  
  logger.info('Iniciando OAuth', { shop, redirectUri });
  res.redirect(tempShopify.getAuthUrl(redirectUri, state));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, shop } = req.query;

  if (state !== app.locals.oauthState) {
    logger.warn('OAuth state inválido');
    return res.status(403).send('State inválido');
  }

  try {
    const tempShopify = new ShopifyClient();
    tempShopify.shopDomain = shop;
    const accessToken = await tempShopify.exchangeCodeForToken(code);
    
    logger.info('OAuth completado', { shop });
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ INSTALACIÓN EXITOSA');
    console.log('='.repeat(60));
    console.log('Access Token:', accessToken);
    console.log('='.repeat(60));
    console.log('Agrégalo a .env como SHOPIFY_ACCESS_TOKEN');
    console.log('='.repeat(60) + '\n');

    res.send(`
      <!DOCTYPE html>
      <html><head><title>Instalación Exitosa</title>
      <style>
        body{font-family:system-ui;padding:40px;max-width:700px;margin:auto}
        .success{background:#d4edda;padding:20px;border-radius:8px;margin-bottom:20px}
        .token{background:#f8f9fa;padding:15px;border-radius:8px;word-break:break-all;font-family:monospace;margin:20px 0}
        .steps{background:#e7f1ff;padding:20px;border-radius:8px}
        code{background:#eee;padding:2px 6px;border-radius:4px}
        pre{background:#333;color:#0f0;padding:10px;border-radius:4px;overflow-x:auto}
      </style></head>
      <body>
        <div class="success"><h1>✅ App instalada en ${shop}</h1></div>
        <h3>Tu Access Token:</h3>
        <div class="token">${accessToken}</div>
        <div class="steps">
          <h3>Próximos pasos:</h3>
          <ol>
            <li>Agrega el token a tu archivo <code>.env</code>:<pre>SHOPIFY_ACCESS_TOKEN=${accessToken}</pre></li>
            <li>Reinicia el servidor: <code>npm start</code></li>
            <li>Configura webhooks:<pre>curl -X POST ${config.server.publicUrl}/api/setup-webhooks</pre></li>
          </ol>
        </div>
      </body></html>
    `);
  } catch (error) {
    logger.error('Error en OAuth', { error: error.message });
    res.status(500).send(`<h1>Error</h1><p>${error.message}</p>`);
  }
});

// ============================================================
// WEBHOOKS DE SHOPIFY
// ============================================================

app.post(config.server.webhookPath, async (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic');
  const shopDomain = req.get('X-Shopify-Shop-Domain');
  const webhookId = req.get('X-Shopify-Webhook-Id');
  
  metrics.webhooksRecibidos++;

  // 1. Verificar firma HMAC
  if (!shopify.verifyWebhookHMAC(req.rawBody, hmac)) {
    logger.warn('Webhook con firma inválida', { topic, shopDomain });
    return res.status(401).send('Unauthorized');
  }

  const resourceId = req.body.id;
  logger.info(`📨 Webhook: ${topic}`, { resourceId, webhookId });

  // 2. Responder inmediatamente (Shopify requiere < 5 segundos)
  res.status(200).send('OK');

  // 3. Deduplicación
  if (!webhookDedupe.tryAcquire(topic, resourceId)) {
    metrics.webhooksDuplicados++;
    logger.debug('Webhook duplicado', { topic, resourceId });
    return;
  }

  // 4. Encolar para procesamiento asíncrono
  const taskId = `${topic}:${resourceId}`;
  const payload = req.body;
  
  webhookQueue.enqueue(
    async () => {
      try {
        switch (topic) {
          case 'orders/paid':
            await procesarPedidoPagado(payload);
            break;
          case 'refunds/create':
            await procesarReembolso(payload);
            break;
          default:
            logger.debug('Webhook ignorado', { topic });
        }
        
        webhookDedupe.complete(topic, resourceId);
        metrics.webhooksProcesados++;
        
      } catch (error) {
        logger.error('Error procesando webhook', { 
          topic, resourceId, error: error.message 
        });
        metrics.errores++;
        webhookDedupe.release(topic, resourceId);
        throw error;
      }
    },
    { id: taskId, priority: topic === 'refunds/create' ? 10 : 5 }
  ).catch(error => {
    logger.error('Error en cola de webhooks', { taskId, error: error.message });
  });
});

// ============================================================
// PROCESAMIENTO DE PEDIDOS
// ============================================================

async function procesarPedidoPagado(order) {
  const orderId = order.id;
  const orderName = order.name || `#${order.order_number}`;
  
  const op = logger.startOperation(orderId, `Procesar pedido ${orderName}`);
  
  try {
    // Validar pedido
    const validacion = validarPedidoShopify(order);
    if (!validacion.valid) {
      logger.warn('Pedido inválido', { errors: validacion.errors });
      return { status: 'error', reason: 'invalid_order', errors: validacion.errors };
    }

    // Verificar si ya facturado
    const tags = (order.tags || '').toLowerCase().split(',').map(t => t.trim());
    if (tags.includes('facturado')) {
      logger.info('Pedido ya facturado', { orderId });
      return { status: 'skipped', reason: 'already_invoiced' };
    }

    // Verificar en store local
    if (comprobanteStore.has(orderId)) {
      logger.info('Comprobante ya existe en store', { orderId });
      return { status: 'skipped', reason: 'exists_in_store' };
    }

    // Convertir a formato Biller
    let billerData = shopifyOrderToBiller(order);
    
    // Validar RUT con DGI si aplica
    if (billerData.cliente && config.facturacion.validarRUTConDGI) {
      try {
        const validacionDGI = await biller.validarRUTConDGI(billerData.cliente.documento);
        
        if (validacionDGI.valid && validacionDGI.razonSocial) {
          billerData.cliente.razon_social = validacionDGI.razonSocial.substring(0, 150);
          billerData.cliente.nombre_fantasia = validacionDGI.razonSocial.substring(0, 150);
          logger.info('RUT validado con DGI', { razonSocial: validacionDGI.razonSocial });
        } else if (!validacionDGI.valid && !validacionDGI.warning) {
          logger.warn('RUT inválido en DGI, cambiando a e-Ticket');
          billerData.tipo_comprobante = config.TIPOS_CFE.E_TICKET;
          delete billerData.cliente;
        }
      } catch (e) {
        logger.warn('Error validando con DGI', { error: e.message });
      }
    }

    // Emitir comprobante
    const comprobante = await biller.emitirComprobante(billerData);
    metrics.comprobantesEmitidos++;

    // Agregar URL pública del PDF (accesible sin auth)
    comprobante.publicPdfUrl = `${config.server.publicUrl}/api/comprobante/${comprobante.id}/pdf`;
    
    // Guardar en store
    comprobanteStore.set(orderId, {
      id: comprobante.id,
      tipo_comprobante: billerData.tipo_comprobante,
      serie: comprobante.serie,
      numero: comprobante.numero,
      cae_numero: comprobante.cae_numero,
      cliente: billerData.cliente || null,
      total: order.total_price,
      shopify_order_name: orderName
    });

    // Marcar en Shopify
    try {
      await shopify.marcarComoFacturado(orderId, comprobante);
    } catch (e) {
      logger.warn('Error marcando como facturado', { error: e.message });
    }

    // Agregar nota
    if (config.facturacion.agregarNotaEnPedido) {
      try {
        await shopify.agregarNotaComprobante(orderId, comprobante);
      } catch (e) {
        logger.debug('Error agregando nota', { error: e.message });
      }
    }

    op.end({ comprobante: `${comprobante.serie}-${comprobante.numero}` });
    
    return { 
      status: 'success', 
      tipo: biller.getTipoComprobanteStr(billerData.tipo_comprobante),
      comprobante: { id: comprobante.id, serie: comprobante.serie, numero: comprobante.numero }
    };
    
  } catch (error) {
    op.fail(error);
    throw error;
  }
}

async function procesarReembolso(refund) {
  const refundId = refund.id;
  const orderId = refund.order_id;
  
  const op = logger.startOperation(refundId, `Procesar reembolso`);
  
  try {
    // Buscar comprobante original
    let comprobanteOriginal = comprobanteStore.get(orderId);
    
    if (!comprobanteOriginal) {
      const encontrado = await biller.buscarPorNumeroInterno(`shopify-${orderId}`);
      if (encontrado) {
        comprobanteOriginal = {
          id: encontrado.id,
          tipo_comprobante: encontrado.tipo_comprobante,
          serie: encontrado.serie,
          numero: encontrado.numero
        };
      }
    }

    if (!comprobanteOriginal) {
      logger.warn('No se encontró comprobante original', { orderId });
      return { status: 'skipped', reason: 'no_original_invoice' };
    }

    // Obtener pedido original
    let originalOrder = null;
    try {
      originalOrder = await shopify.getOrder(orderId);
    } catch (e) {
      logger.warn('No se pudo obtener pedido original', { error: e.message });
    }

    // Determinar tipo de NC
    const tipoOriginal = comprobanteOriginal.tipo_comprobante;
    const tipoNC = (tipoOriginal === 111 || tipoOriginal === 112 || tipoOriginal === 113)
      ? config.TIPOS_CFE.NC_E_FACTURA
      : config.TIPOS_CFE.NC_E_TICKET;

    // Items de la NC
    const ncItems = shopifyRefundToNCItems(refund, originalOrder);
    if (ncItems.length === 0) {
      logger.warn('Reembolso sin items');
      return { status: 'skipped', reason: 'no_items' };
    }

    // Datos de la NC
    const emailCliente = originalOrder?.email || originalOrder?.customer?.email;

    const ncData = {
      tipo_comprobante: tipoNC,
      items: ncItems,
      numero_interno: `shopify-refund-${refundId}`,
      numero_orden: `refund-${refundId}`,
      informacion_adicional: `NC por reembolso - Original: ${comprobanteOriginal.serie}-${comprobanteOriginal.numero}`,
      referencias: [{
        tipo: tipoOriginal,
        serie: comprobanteOriginal.serie,
        numero: comprobanteOriginal.numero
      }],
      emails_notificacion: emailCliente ? [emailCliente] : undefined
    };

    if (comprobanteOriginal.cliente) {
      ncData.cliente = comprobanteOriginal.cliente;
    }

    // Emitir NC
    const nc = await biller.emitirComprobante(ncData);
    metrics.comprobantesEmitidos++;

    // Guardar
    comprobanteStore.set(`refund-${refundId}`, {
      id: nc.id,
      tipo_comprobante: tipoNC,
      serie: nc.serie,
      numero: nc.numero,
      cae_numero: nc.cae_numero,
      referencia: `${comprobanteOriginal.serie}-${comprobanteOriginal.numero}`,
      shopify_order_id: orderId
    });

    op.end({ nc: `${nc.serie}-${nc.numero}` });
    
    return { 
      status: 'success', 
      tipo: biller.getTipoComprobanteStr(tipoNC),
      comprobante: { id: nc.id, serie: nc.serie, numero: nc.numero }
    };
    
  } catch (error) {
    op.fail(error);
    throw error;
  }
}

// ============================================================
// API ENDPOINTS
// ============================================================

app.get('/api/llamados', (req, res) => {
  const sampleRequest = {
    tipo_comprobante: 101,
    forma_pago: 1,
    sucursal: parseInt(config.biller.empresa.sucursal) || 0,
    moneda: 'UYU',
    montos_brutos: 0,
    numero_interno: 'shopify-6223490318518',
    numero_orden: 'Pedido Shopify #1005',
    items: [{
      codigo: 'CAMI-001',
      cantidad: 1,
      concepto: 'Camiseta manga corta',
      descripcion: 'Camiseta manga corta',
      precio: 1000,
      indicador_facturacion: 3,
      unidad_medida: 'UN'
    }]
  };

  const sampleResponse = {
    id: 43574,
    serie: 'C',
    numero: '2055262',
    hash: 'ym4F2zXETOX9sw7xVxOn/6uGDdw='
  };

  const fieldFixes = [
    { wrong: 'id_externo', right: 'numero_interno' },
    { wrong: 'formas_pago[]', right: 'forma_pago' },
    { wrong: 'nombre', right: 'concepto' },
    { wrong: 'precio_unitario', right: 'precio' },
    { wrong: 'indicador_iva', right: 'indicador_facturacion' },
    { wrong: 'unidad', right: 'unidad_medida' },
    { wrong: 'emailCliente', right: 'emails_notificacion (array)' },
    { wrong: 'empresa_id', right: 'No se envía: el token identifica la empresa' }
  ];

  const errorCodes = [
    { code: 400, meaning: 'Bad Request - La solicitud contiene sintaxis errónea, no debería repetirse.' },
    { code: 403, meaning: 'Forbidden -- No tiene los privilegios para hacer la solicitud realizada.' },
    { code: 404, meaning: 'Not Found -- Página o recurso no encontrado.' },
    { code: 422, meaning: 'La solicitud está correcta sintácticamente, pero contiene errores en los datos.' }
  ];

  const escapeHtml = (str) => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const renderJson = (obj) => escapeHtml(JSON.stringify(obj, null, 2));

  res.type('html').send(`<!DOCTYPE html>
  <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Vista de API · Llamados</title>
      <style>
        :root {
          --bg: #0b1021;
          --panel: #0f172a;
          --panel-2: #101827;
          --accent: #38bdf8;
          --accent-2: #22c55e;
          --muted: #8ba0c2;
          --border: rgba(255,255,255,0.07);
          --warning: #f59e0b;
          --error: #f87171;
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 40px 24px 64px;
          font-family: 'Space Grotesk', 'Segoe UI', 'Helvetica Neue', sans-serif;
          background: radial-gradient(circle at 20% 20%, rgba(56, 189, 248, 0.12), transparent 30%),
                      radial-gradient(circle at 80% 0%, rgba(34, 197, 94, 0.12), transparent 30%),
                      var(--bg);
          color: #e5e7eb;
          min-height: 100vh;
        }
        main {
          max-width: 1080px;
          margin: 0 auto;
          display: grid;
          gap: 24px;
        }
        header {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        h1 {
          margin: 0;
          font-size: 28px;
          letter-spacing: -0.5px;
        }
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: rgba(255,255,255,0.04);
          color: var(--muted);
          font-size: 13px;
        }
        .pill strong { color: #f8fafc; }
        .grid {
          display: grid;
          gap: 16px;
        }
        .grid.two {
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        }
        .card {
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 18px;
          box-shadow: 0 10px 50px rgba(0,0,0,0.35);
        }
        .card h3 {
          margin: 0 0 10px;
          font-size: 16px;
          letter-spacing: 0.1px;
        }
        .sub {
          color: var(--muted);
          margin-top: 4px;
          font-size: 13px;
        }
        pre {
          margin: 12px 0 0;
          padding: 14px;
          background: #0a0f1d;
          border-radius: 12px;
          border: 1px solid var(--border);
          overflow-x: auto;
          font-size: 13px;
          line-height: 1.5;
          color: #d1e7ff;
        }
        code { font-family: 'SFMono-Regular', Menlo, Monaco, Consolas, monospace; }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 8px;
        }
        th, td {
          padding: 10px 8px;
          text-align: left;
          border-bottom: 1px solid var(--border);
          font-size: 14px;
        }
        th { color: #cbd5f5; font-weight: 600; }
        td.code { width: 70px; color: #f8fafc; font-weight: 700; }
        .chip-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .chip {
          padding: 7px 11px;
          border-radius: 12px;
          border: 1px solid var(--border);
          background: rgba(56, 189, 248, 0.08);
          color: #c7e9ff;
          font-size: 13px;
        }
        .chip.warn { background: rgba(249, 115, 22, 0.08); color: #fdba74; }
        .badge-row {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .badge {
          padding: 10px 12px;
          border-radius: 12px;
          background: var(--panel);
          border: 1px solid var(--border);
          font-size: 13px;
          color: #d1d9ec;
        }
        .badge strong { display: block; color: #f8fafc; font-size: 14px; }
        @media (max-width: 640px) {
          body { padding: 28px 16px; }
          header { flex-direction: column; }
        }
      </style>
    </head>
    <body>
      <main>
        <header>
          <div>
            <h1>Vista de llamados a API</h1>
            <div class="sub">Ejemplo válido para Biller v2 y guía de mapeos corregidos</div>
          </div>
          <span class="pill">URL pública <strong>${config.server.publicUrl || 'No configurada'}</strong></span>
        </header>

        <div class="badge-row">
          <div class="badge"><strong>Ambiente Biller</strong>${config.biller.environment || 'No configurado'}</div>
          <div class="badge"><strong>Base URL</strong>${config.biller.baseUrl}</div>
          <div class="badge"><strong>Empresa</strong>${config.biller.empresa.nombre || 'Sin nombre'}</div>
          <div class="badge"><strong>Tienda Shopify</strong>${config.shopify.shopDomain || 'No configurada'}</div>
        </div>

        <div class="grid two">
          <div class="card">
            <h3>Solicitud enviada</h3>
            <div class="sub">POST /comprobantes</div>
            <pre><code>${renderJson(sampleRequest)}</code></pre>
          </div>

          <div class="card">
            <h3>Respuesta recibida</h3>
            <div class="sub">Respuesta típica al emitir un CFE</div>
            <pre><code>${renderJson(sampleResponse)}</code></pre>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h3>Mapeo de campos corregidos</h3>
            <div class="sub">Lo que enviaba la integración vs lo que requiere Biller v2</div>
            <div class="chip-row" style="margin-top:10px;flex-wrap:wrap;">
              ${fieldFixes.map(f => `
                <span class="chip warn">${f.wrong} → <strong style="color:#f8fafc">${f.right}</strong></span>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="grid two">
          <div class="card">
            <h3>Códigos de error relevantes</h3>
            <table>
              <thead>
                <tr><th>Código</th><th>Significado</th></tr>
              </thead>
              <tbody>
                ${errorCodes.map(e => `
                  <tr>
                    <td class="code">${e.code}</td>
                    <td>${e.meaning}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h3>Tips rápidos</h3>
            <ul style="margin: 6px 0 0 18px; color: var(--muted); line-height: 1.5; padding-left: 4px;">
              <li>Usa solo campos soportados por la versión v2 de Biller.</li>
              <li>Verifica los códigos de error para saber si es sintaxis (400) o validación de datos (422).</li>
              <li>Si migras a v3, revisa el contrato de campos permitidos antes de reenviar.</li>
              <li>Comprueba que la URL pública sea accesible desde Biller/Shopify.</li>
            </ul>
          </div>
        </div>
      </main>
    </body>
  </html>`);
});

app.post('/api/facturar/:orderId', async (req, res) => {
  try {
    const order = await shopify.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    
    const resultado = await procesarPedidoPagado(order);
    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/facturar-pendientes', async (req, res) => {
  try {
    const pedidos = await shopify.getOrdersPendientesFacturar();
    const resultados = [];
    
    for (const order of pedidos) {
      try {
        const resultado = await procesarPedidoPagado(order);
        resultados.push({ order_id: order.id, order_name: order.name, ...resultado });
      } catch (error) {
        resultados.push({ order_id: order.id, order_name: order.name, status: 'error', error: error.message });
      }
      await new Promise(r => setTimeout(r, 500));
    }
    
    res.json({
      total: pedidos.length,
      exitosos: resultados.filter(r => r.status === 'success').length,
      saltados: resultados.filter(r => r.status === 'skipped').length,
      errores: resultados.filter(r => r.status === 'error').length,
      resultados
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/setup-webhooks', async (req, res) => {
  if (!config.shopify.accessToken) {
    return res.status(400).json({ error: 'Access Token no configurado' });
  }
  
  try {
    const result = await shopify.setupWebhooks();
    res.json({ status: 'ok', webhooks: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/webhooks-status', async (req, res) => {
  if (!config.shopify.accessToken) {
    return res.json({ configured: false, error: 'Access Token no configurado' });
  }
  
  try {
    const status = await shopify.verificarWebhooks();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/test-biller', async (req, res) => {
  const result = await biller.verificarConexion();
  res.json(result);
});

app.get('/api/comprobante/:id/pdf', async (req, res) => {
  try {
    const pdf = await biller.obtenerPDF(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="comprobante-${req.params.id}.pdf"`);
    res.send(Buffer.from(pdf));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Buscar comprobante por Order ID de Shopify (para Order Status Page)
app.get('/api/comprobante/orden/:shopifyOrderId', (req, res) => {
  // Permitir CORS para que Shopify pueda llamar desde su dominio
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const shopifyOrderId = req.params.shopifyOrderId;
  const comprobante = comprobanteStore.get(shopifyOrderId);

  if (!comprobante) {
    return res.status(404).json({ found: false, message: 'Comprobante no encontrado' });
  }

  res.json({
    found: true,
    comprobante: {
      id: comprobante.id,
      numero: `${comprobante.serie}-${comprobante.numero}`,
      tipo: comprobante.tipo_comprobante,
      cae: comprobante.cae_numero,
      pdfUrl: `${config.server.publicUrl}/api/comprobante/${comprobante.id}/pdf`,
      viewUrl: `${config.server.publicUrl}/comprobante/${comprobante.id}`
    }
  });
});

// Página HTML para ver/descargar comprobante (amigable para clientes)
app.get('/comprobante/:id', async (req, res) => {
  const comprobanteId = req.params.id;
  const pdfUrl = `${config.server.publicUrl}/api/comprobante/${comprobanteId}/pdf`;

  // Buscar info del comprobante en el store local
  const allComprobantes = comprobanteStore.getAll();
  const info = allComprobantes.find(c => c.data?.id === parseInt(comprobanteId));
  const numero = info?.data?.serie && info?.data?.numero
    ? `${info.data.serie}-${info.data.numero}`
    : comprobanteId;

  res.type('html').send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comprobante ${numero}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 20px;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 400px;
      width: 100%;
    }
    .icon {
      font-size: 64px;
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      color: #1a1a2e;
    }
    .numero {
      color: #667eea;
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 24px;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      text-decoration: none;
      padding: 16px 32px;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
    }
    .info {
      margin-top: 24px;
      font-size: 13px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🧾</div>
    <h1>Comprobante Fiscal</h1>
    <div class="numero">${numero}</div>
    <a href="${pdfUrl}" class="btn" download>Descargar PDF</a>
    <p class="info">
      Comprobante fiscal electr\u00f3nico emitido por<br>
      <strong>${config.biller.empresa.nombre || 'Empresa'}</strong>
    </p>
  </div>
</body>
</html>`);
});

app.post('/api/comprobante/:id/reenviar', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  
  try {
    await biller.enviarComprobantePorEmail(req.params.id, email);
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/comprobantes', (req, res) => {
  const comprobantes = comprobanteStore.getAll();
  res.json({ total: comprobantes.length, comprobantes });
});

app.get('/api/comprobantes/stats', (req, res) => {
  res.json(comprobanteStore.getStats());
});

// ============================================================
// DASHBOARD
// ============================================================

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ============================================================
// ERRORES
// ============================================================

app.get('/api/errors/unresolved', (req, res) => {
  const { type, limit, since } = req.query;
  const errors = errorStore.getUnresolvedErrors({
    type,
    limit: parseInt(limit) || 100,
    since
  });
  res.json({ total: errors.length, errors });
});

app.get('/api/errors/by-type', (req, res) => {
  const { type, resolved, limit } = req.query;
  if (!type) {
    return res.status(400).json({ error: 'Parámetro type requerido' });
  }
  const errors = errorStore.getErrorsByType(type, {
    resolved: resolved === 'true' ? true : resolved === 'false' ? false : undefined,
    limit: parseInt(limit) || 100
  });
  res.json({ total: errors.length, errors });
});

app.get('/api/errors/by-order/:orderId', (req, res) => {
  const errors = errorStore.getErrorsByOrder(req.params.orderId);
  res.json({ total: errors.length, errors });
});

app.post('/api/errors/:id/resolve', (req, res) => {
  const { notes, by } = req.body;
  const resolved = errorStore.resolveError(req.params.id, { notes, by });
  if (resolved) {
    res.json({ status: 'ok', message: 'Error marcado como resuelto' });
  } else {
    res.status(404).json({ error: 'Error no encontrado' });
  }
});

app.get('/api/errors/stats', (req, res) => {
  res.json(errorStore.getStats());
});

// ============================================================
// RECONCILIACIÓN
// ============================================================

app.post('/api/reconciliation/quick', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const resultado = await reconciliationService.reconciliacionRapida(limit);

    auditLogger.reconciliacionEjecutada({
      tipo: 'quick',
      total: resultado.resumen.total,
      verificados: resultado.resumen.verificados,
      discrepancias: resultado.resumen.discrepancias,
      errores: resultado.resumen.errores,
      reporteId: resultado.id,
      duration: resultado.duracionMs
    });

    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reconciliation/full', async (req, res) => {
  try {
    const resultado = await reconciliationService.reconciliacionCompleta();

    auditLogger.reconciliacionEjecutada({
      tipo: 'full',
      total: resultado.resumen.total,
      verificados: resultado.resumen.verificados,
      discrepancias: resultado.resumen.discrepancias,
      errores: resultado.resumen.errores,
      reporteId: resultado.id,
      duration: resultado.duracionMs
    });

    res.json(resultado);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reconciliation/reports', (req, res) => {
  const reports = reconciliationService.listarReportes();
  res.json({ total: reports.length, reports });
});

app.get('/api/reconciliation/report/:id', (req, res) => {
  const report = reconciliationService.obtenerReporte(req.params.id);
  if (report) {
    res.json(report);
  } else {
    res.status(404).json({ error: 'Reporte no encontrado' });
  }
});

// ============================================================
// AUDITORÍA
// ============================================================

app.get('/api/audit/recent', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const entries = auditLogger.getRecent(hours);
  res.json({ total: entries.length, entries });
});

app.get('/api/audit/by-order/:orderId', (req, res) => {
  const entries = auditLogger.getByOrder(req.params.orderId);
  res.json({ total: entries.length, entries });
});

app.get('/api/audit/stats', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  res.json(auditLogger.getStats(days));
});

// ============================================================
// BILLING DECISION
// ============================================================

app.get('/api/billing-decision/stats', (req, res) => {
  res.json(billingDecision.getStats());
});

app.post('/api/billing-decision/update-ui', (req, res) => {
  const { valorUI } = req.body;
  if (!valorUI || isNaN(valorUI)) {
    return res.status(400).json({ error: 'valorUI requerido y debe ser numérico' });
  }
  billingDecision.actualizarValorUI(parseFloat(valorUI));
  res.json({
    status: 'ok',
    message: `Valor UI actualizado a ${valorUI}`,
    limiteUYU: billingDecision.limiteUI * parseFloat(valorUI)
  });
});

// ============================================================
// CACHE
// ============================================================

app.get('/api/cache/stats', (req, res) => {
  res.json(billerCache.getStats());
});

app.post('/api/cache/clear', (req, res) => {
  billerCache.clear();
  res.json({ status: 'ok', message: 'Cache limpiado' });
});

// ============================================================
// PDF WORKER
// ============================================================

app.get('/api/pdf-worker/stats', (req, res) => {
  res.json(pdfWorker.getStats());
});

app.get('/api/pdf-worker/failed', (req, res) => {
  res.json({ jobs: pdfWorker.getFailedJobs() });
});

app.post('/api/pdf-worker/retry/:jobId', (req, res) => {
  const retried = pdfWorker.retryJob(req.params.jobId);
  if (retried) {
    res.json({ status: 'ok', message: 'Job reintentado' });
  } else {
    res.status(404).json({ error: 'Job no encontrado o no está fallido' });
  }
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
  logger.error('Error no manejado', { error: err.message, path: req.path });
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let server;

function gracefulShutdown(signal) {
  logger.info(`Recibida señal ${signal}, cerrando...`);
  
  // Guardar comprobantes
  comprobanteStore.stopAutoSave();
  
  if (server) {
    server.close(() => {
      logger.info('Servidor cerrado');
      process.exit(0);
    });
    
    // Forzar cierre después de timeout
    setTimeout(() => {
      logger.warn('Forzando cierre');
      process.exit(1);
    }, config.server.shutdownTimeout);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Excepción no capturada', { error: error.message, stack: error.stack });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Promise rechazada', { reason: String(reason) });
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

async function iniciar() {
  // Validar configuración
  if (!config.mostrarErrores()) {
    process.exit(1);
  }

  server = app.listen(config.server.port, async () => {
    console.log('\n' + '═'.repeat(60));
    console.log('🚀 INTEGRACIÓN SHOPIFY ↔ BILLER v2.1');
    console.log('═'.repeat(60));
    console.log(`📍 Puerto:      ${config.server.port}`);
    console.log(`🌍 Ambiente:    ${config.biller.environment}`);
    console.log(`🏪 Tienda:      ${config.shopify.shopDomain}`);
    console.log(`🏢 Empresa:     ${config.biller.empresa.nombre}`);
    console.log(`🔗 URL:         ${config.server.publicUrl}`);
    console.log(`📊 Dashboard:   ${config.server.publicUrl}/dashboard`);
    console.log(`💰 Límite UI:   ${config.facturacion.limiteUI} UI (~$${config.facturacion.limiteUYU})`);
    console.log('═'.repeat(60));

    // Verificar conexiones
    const billerStatus = await biller.verificarConexion();
    console.log(billerStatus.connected 
      ? `\n✅ Biller: ${billerStatus.empresa}` 
      : `\n❌ Biller: ${billerStatus.error}`);

    if (config.shopify.accessToken) {
      console.log('✅ Shopify: Token configurado');
      try {
        const wh = await shopify.verificarWebhooks();
        if (wh.ok) {
          console.log('✅ Webhooks: OK');
        } else {
          console.log(`⚠️  Webhooks: Ejecuta POST /api/setup-webhooks`);
        }
      } catch (e) {
        console.log(`⚠️  Webhooks: ${e.message}`);
      }
    } else {
      console.log(`\n⚠️  Visita ${config.server.publicUrl}/install para obtener token`);
    }

    console.log(`\n📊 Comprobantes en store: ${comprobanteStore.size}`);
    console.log('═'.repeat(60) + '\n');
  });
}

iniciar();
