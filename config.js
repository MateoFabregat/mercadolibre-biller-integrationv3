/**
 * Configuración de la integración Shopify ↔ Biller
 * @module config
 */

require('dotenv').config();

/**
 * Tipos de comprobantes fiscales electrónicos (CFE) en Uruguay
 */
const TIPOS_CFE = Object.freeze({
  E_TICKET: 101,
  NC_E_TICKET: 102,
  ND_E_TICKET: 103,
  E_FACTURA: 111,
  NC_E_FACTURA: 112,
  ND_E_FACTURA: 113,
  E_TICKET_CONTINGENCIA: 121,
  NC_E_TICKET_CONTINGENCIA: 122,
  ND_E_TICKET_CONTINGENCIA: 123,
  E_FACTURA_CONTINGENCIA: 131,
  NC_E_FACTURA_CONTINGENCIA: 132,
  ND_E_FACTURA_CONTINGENCIA: 133
});

/**
 * Tipos de documento de identidad
 */
const TIPOS_DOCUMENTO = Object.freeze({
  CI: 3,        // Cédula de Identidad
  RUT: 2,       // RUT
  PASAPORTE: 4, // Pasaporte
  OTRO: 5       // Otro
});

/**
 * Formas de pago
 */
const FORMAS_PAGO = Object.freeze({
  EFECTIVO: 1,
  TARJETA_CREDITO: 2,
  TARJETA_DEBITO: 3,
  TRANSFERENCIA: 4,
  CREDITO: 5,
  CHEQUE: 6,
  OTRO: 99
});

/**
 * Indicadores de IVA
 */
const INDICADORES_IVA = Object.freeze({
  EXENTO: 1,
  GRAVADO_MINIMA: 2,   // 10%
  GRAVADO_BASICA: 3,   // 22%
  NO_GRAVADO: 4
});

/**
 * Configuración principal
 */
const config = {
  // Constantes
  TIPOS_CFE,
  TIPOS_DOCUMENTO,
  FORMAS_PAGO,
  INDICADORES_IVA,

  // ============================================================
  // BILLER
  // ============================================================
  biller: {
    environment: process.env.BILLER_ENVIRONMENT || 'test',
    token: process.env.BILLER_TOKEN,
    
    get baseUrl() {
      return this.environment === 'production'
        ? 'https://biller.uy/v2'
        : 'https://test.biller.uy/v2';
    },
    
    empresa: {
      id: process.env.BILLER_EMPRESA_ID,
      rut: process.env.BILLER_EMPRESA_RUT,
      sucursal: process.env.BILLER_EMPRESA_SUCURSAL || null,
      nombre: process.env.BILLER_EMPRESA_NOMBRE || 'Mi Empresa'
    },

    // Configuración de reintentos
    retry: {
      maxAttempts: parseInt(process.env.BILLER_RETRY_ATTEMPTS) || 3,
      initialDelay: parseInt(process.env.BILLER_RETRY_DELAY) || 1000,
      maxDelay: parseInt(process.env.BILLER_RETRY_MAX_DELAY) || 10000,
      backoffFactor: 2
    },

    // Timeout de requests
    timeout: parseInt(process.env.BILLER_TIMEOUT) || 30000
  },

  // ============================================================
  // SHOPIFY
  // ============================================================
  shopify: {
    shop: process.env.SHOPIFY_SHOP,
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
    scopes: 'read_orders,write_orders,read_customers',
    
    get shopDomain() {
      const shop = this.shop || '';
      return shop.includes('.myshopify.com') ? shop : `${shop}.myshopify.com`;
    }
  },

  // ============================================================
  // SERVIDOR
  // ============================================================
  server: {
    port: parseInt(process.env.SERVER_PORT) || 3000,
    publicUrl: process.env.SERVER_PUBLIC_URL || 'http://localhost:3000',
    webhookPath: '/webhooks/shopify',
    
    // Graceful shutdown timeout
    shutdownTimeout: parseInt(process.env.SHUTDOWN_TIMEOUT) || 10000
  },

  // ============================================================
  // FACTURACIÓN
  // ============================================================
  facturacion: {
    validarRUTConDGI: process.env.VALIDAR_RUT_CON_DGI === 'true',
    enviarAlCliente: process.env.ENVIAR_COMPROBANTE_CLIENTE !== 'false',
    agregarNotaEnPedido: process.env.AGREGAR_LINK_EN_PEDIDO !== 'false',

    // IVA por defecto (22% = tasa básica)
    ivaDefault: parseInt(process.env.IVA_DEFAULT) || 22,

    // Regla 5000 UI - DGI Uruguay
    // Ventas mayores a 5000 UI requieren identificación del comprador
    limiteUI: parseInt(process.env.LIMITE_UI_ETICKET) || 5000,
    valorUI: parseFloat(process.env.VALOR_UI_UYU) || 6.0, // Actualizar periódicamente

    get limiteUYU() {
      return this.limiteUI * this.valorUI;
    },

    // Campos donde buscar RUT
    camposRUT: [
      'rut', 'RUT', 'rut_ci', 'RUT_CI', 'documento', 'tax_id',
      'vat_number', 'ruc', 'ci', 'CI', 'cedula'
    ],

    // Campos donde buscar razón social
    camposRazonSocial: [
      'razon_social', 'razonSocial', 'empresa', 'company',
      'business_name', 'nombre_empresa'
    ]
  },

  // ============================================================
  // RECONCILIACIÓN
  // ============================================================
  reconciliation: {
    // Directorio de reportes
    reportsDir: process.env.RECONCILIATION_REPORTS_DIR || './data/reconciliation-reports',

    // Retención de reportes (días)
    retentionDays: parseInt(process.env.RECONCILIATION_RETENTION_DAYS) || 30
  },

  // ============================================================
  // CACHE
  // ============================================================
  cache: {
    // TTL del cache de búsquedas Biller (ms)
    billerSearchTTL: parseInt(process.env.CACHE_BILLER_TTL) || 5 * 60 * 1000,

    // Tamaño máximo del cache
    maxSize: parseInt(process.env.CACHE_MAX_SIZE) || 1000
  },

  // ============================================================
  // AUDITORÍA
  // ============================================================
  audit: {
    // Directorio de logs de auditoría
    logsDir: process.env.AUDIT_LOGS_DIR || './data/audit',

    // Retención de logs (días)
    retentionDays: parseInt(process.env.AUDIT_RETENTION_DAYS) || 90,

    // Buffer flush interval (ms)
    flushInterval: parseInt(process.env.AUDIT_FLUSH_INTERVAL) || 5000
  },

  // ============================================================
  // PROCESAMIENTO
  // ============================================================
  procesamiento: {
    // Máximo de webhooks concurrentes
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_WEBHOOKS) || 3,
    
    // Tiempo de deduplicación (ms)
    dedupeWindow: parseInt(process.env.DEDUPE_WINDOW) || 5 * 60 * 1000,
    
    // Intervalo de limpieza de cache (ms)
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL) || 10 * 60 * 1000
  },

  // ============================================================
  // PERSISTENCIA
  // ============================================================
  storage: {
    // Ruta del archivo de comprobantes
    comprobantesFile: process.env.STORAGE_FILE || './data/comprobantes.json',
    
    // Auto-guardar cada N segundos
    autoSaveInterval: parseInt(process.env.AUTO_SAVE_INTERVAL) || 30
  },

  // ============================================================
  // LOGGING
  // ============================================================
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'pretty', // 'pretty' o 'json'
    includeTimestamp: true
  }
};

/**
 * Validar configuración requerida
 * @returns {{valid: boolean, errors: string[]}}
 */
function validarConfiguracion() {
  const errors = [];
  
  // Biller
  if (!config.biller.token) {
    errors.push('BILLER_TOKEN es requerido');
  }
  if (!config.biller.empresa.id) {
    errors.push('BILLER_EMPRESA_ID es requerido');
  }
  if (config.biller.empresa.rut && !/^\d{12}$/.test(config.biller.empresa.rut)) {
    errors.push('BILLER_EMPRESA_RUT debe tener 12 dígitos');
  }
  
  // Shopify
  if (!config.shopify.shop) {
    errors.push('SHOPIFY_SHOP es requerido');
  }
  if (!config.shopify.apiKey) {
    errors.push('SHOPIFY_API_KEY es requerido');
  }
  if (!config.shopify.apiSecret) {
    errors.push('SHOPIFY_API_SECRET es requerido');
  }
  
  // Servidor
  if (!config.server.publicUrl || config.server.publicUrl === 'http://localhost:3000') {
    errors.push('SERVER_PUBLIC_URL debe configurarse con la URL pública');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Mostrar errores de configuración
 */
function mostrarErrores() {
  const { valid, errors } = validarConfiguracion();
  
  if (!valid) {
    console.error('\n❌ Errores de configuración:');
    errors.forEach(e => console.error(`   • ${e}`));
    console.error('\nRevisa tu archivo .env\n');
  }
  
  return valid;
}

config.validar = validarConfiguracion;
config.mostrarErrores = mostrarErrores;

module.exports = config;
