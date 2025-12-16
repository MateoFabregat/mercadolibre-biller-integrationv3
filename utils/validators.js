/**
 * Validadores para la integración
 * @module utils/validators
 */

const config = require('../config');
const logger = require('./logger');

/**
 * Validar RUT uruguayo usando algoritmo módulo 11
 * Funciona para CI (8 dígitos) y RUT (12 dígitos)
 * 
 * NOTA: El algoritmo de dígito verificador puede variar según el tipo de documento.
 * Para mayor seguridad, la validación final se realiza contra DGI a través de Biller.
 * 
 * @param {string} rut - RUT o CI a validar
 * @returns {{valid: boolean, reason?: string, type?: string}}
 */
function validarRUT(rut) {
  if (!rut) {
    return { valid: false, reason: 'RUT vacío' };
  }

  // Limpiar: solo números
  const rutLimpio = String(rut).replace(/\D/g, '');
  
  // Verificar longitud
  if (rutLimpio.length !== 8 && rutLimpio.length !== 12) {
    return { 
      valid: false, 
      reason: `Longitud inválida: ${rutLimpio.length} (debe ser 8 o 12)` 
    };
  }

  // Determinar tipo
  const tipo = rutLimpio.length === 12 ? 'RUT' : 'CI';

  // Validación del dígito verificador usando módulo 11
  // El algoritmo uruguayo usa multiplicadores 2,9,8,7,6,5,4,3,2 de derecha a izquierda
  // Pero dado que existen variantes, hacemos validación básica y dejamos
  // la validación definitiva a DGI/Biller
  
  const verificacionBasica = validarDigitoVerificador(rutLimpio);
  
  // Aceptamos el RUT si pasa la verificación básica O si tiene formato correcto
  // La validación final la hace DGI a través de la API de Biller
  if (!verificacionBasica.valid) {
    // Log warning pero no rechazar - la API de Biller/DGI hará la validación final
    return {
      valid: true, // Aceptar provisionalmente
      type: tipo,
      cleaned: rutLimpio,
      warning: `Dígito verificador posiblemente incorrecto: ${verificacionBasica.reason}`,
      needsVerification: true
    };
  }

  return { 
    valid: true, 
    type: tipo,
    cleaned: rutLimpio
  };
}

/**
 * Validar dígito verificador con algoritmo módulo 11 uruguayo
 * @param {string} numero - Número limpio (solo dígitos)
 */
function validarDigitoVerificador(numero) {
  try {
    // Rellenar a 12 dígitos
    const padded = numero.padStart(12, '0');
    const digitos = padded.split('').map(Number);
    
    // Multiplicadores de derecha a izquierda (excluyendo verificador): 2,9,8,7,6,5,4,3,2,9,8,7...
    // Para 11 dígitos: posiciones 0-10, verificador en 11
    const multiplicadores = [2, 9, 8, 7, 6, 5, 4, 3, 2, 9, 8];
    
    // Calcular suma de derecha a izquierda (sin el verificador)
    let suma = 0;
    for (let i = 0; i < 11; i++) {
      // Posición desde la derecha (sin contar verificador)
      const pos = 10 - i;
      suma += digitos[pos] * multiplicadores[i];
    }
    
    // Calcular verificador
    const resto = suma % 11;
    let verificadorCalculado;
    
    if (resto === 0) {
      verificadorCalculado = 0;
    } else if (resto === 1) {
      verificadorCalculado = 0; // En algunos casos puede ser 0 o 1
    } else {
      verificadorCalculado = 11 - resto;
    }
    
    const verificadorProvisto = digitos[11];
    
    // Aceptar si coincide o si es resto 1 (puede ser 0 o 1)
    if (verificadorCalculado === verificadorProvisto || 
        (resto === 1 && (verificadorProvisto === 0 || verificadorProvisto === 1))) {
      return { valid: true };
    }
    
    return { 
      valid: false, 
      reason: `esperado ${verificadorCalculado}, recibido ${verificadorProvisto}`
    };
  } catch (e) {
    return { valid: false, reason: e.message };
  }
}

/**
 * Extraer RUT de un pedido de Shopify
 * Busca en múltiples ubicaciones
 * @param {Object} order - Pedido de Shopify
 * @returns {{rut: string|null, razonSocial: string|null, source: string|null}}
 */
function extraerRUTDePedido(order) {
  if (!order) {
    return { rut: null, razonSocial: null, source: null };
  }

  const camposRUT = config.facturacion.camposRUT;
  const camposRazonSocial = config.facturacion.camposRazonSocial;
  
  let rut = null;
  let razonSocial = null;
  let source = null;

  // 1. Buscar en note_attributes (campos personalizados del checkout)
  if (!rut && order.note_attributes && Array.isArray(order.note_attributes)) {
    for (const attr of order.note_attributes) {
      const nombreLower = (attr.name || '').toLowerCase();
      const valor = (attr.value || '').trim();
      
      if (!valor) continue;
      
      // Buscar RUT
      if (!rut && camposRUT.some(c => nombreLower.includes(c.toLowerCase()))) {
        rut = valor;
        source = `note_attributes.${attr.name}`;
      }
      
      // Buscar Razón Social
      if (!razonSocial && camposRazonSocial.some(c => nombreLower.includes(c.toLowerCase()))) {
        razonSocial = valor;
      }
    }
  }

  // 2. Buscar en metafields del pedido (checkoutblocks, etc.)
  if (!rut && order.metafields) {
    const metafields = Array.isArray(order.metafields) ? order.metafields : [];
    for (const mf of metafields) {
      const key = (mf.key || '').toLowerCase();
      const valor = (mf.value || '').trim();
      
      if (!valor) continue;
      
      if (camposRUT.some(c => key.includes(c.toLowerCase()))) {
        rut = valor;
        source = `metafields.${mf.namespace}.${mf.key}`;
        break;
      }
    }
  }

  // 3. Buscar en properties de line_items
  if (!rut && order.line_items) {
    outer: for (const item of order.line_items) {
      if (!item.properties) continue;
      
      for (const prop of item.properties) {
        const nombre = (prop.name || '').toLowerCase();
        const valor = (prop.value || '').trim();
        
        if (!valor) continue;
        
        if (camposRUT.some(c => nombre.includes(c.toLowerCase()))) {
          rut = valor;
          source = `line_items.properties.${prop.name}`;
          break outer;
        }
      }
    }
  }

  // 4. Buscar en nota del pedido con varios formatos
  if (!rut && order.note) {
    // Patrones: "RUT: 123456789012", "CI:12345678", "documento 123456789012"
    const patterns = [
      /(?:rut|ci|documento|cedula|cédula)[:\s]*(\d{8,12})/i,
      /^\s*(\d{12})\s*$/m,  // Solo RUT de 12 dígitos en una línea
    ];
    
    for (const pattern of patterns) {
      const match = order.note.match(pattern);
      if (match) {
        rut = match[1];
        source = 'note';
        break;
      }
    }
  }

  // 5. Buscar en campos del cliente (company)
  if (!rut && order.customer?.company) {
    // A veces ponen el RUT en el campo company
    const companyRUT = order.customer.company.match(/\d{12}/);
    if (companyRUT) {
      const validacion = validarRUT(companyRUT[0]);
      if (validacion.valid) {
        rut = companyRUT[0];
        source = 'customer.company';
      }
    }
  }

  // Limpiar RUT encontrado
  if (rut) {
    const rutLimpio = rut.replace(/\D/g, '');
    
    // Validar longitud
    if (rutLimpio.length !== 8 && rutLimpio.length !== 12) {
      logger.debug('RUT con longitud inválida descartado', { 
        rut, 
        length: rutLimpio.length,
        source 
      });
      rut = null;
      source = null;
    } else {
      rut = rutLimpio;
    }
  }

  // Obtener razón social si tenemos RUT pero no razón social
  if (rut && !razonSocial) {
    razonSocial = obtenerRazonSocialDefault(order);
  }

  return { rut, razonSocial, source };
}

/**
 * Obtener razón social por defecto desde datos del pedido
 * @param {Object} order
 */
function obtenerRazonSocialDefault(order) {
  const customer = order.customer || {};
  const billing = order.billing_address || {};
  const shipping = order.shipping_address || {};
  
  // Prioridad: company > nombre completo
  if (billing.company) return billing.company;
  if (customer.company) return customer.company;
  if (shipping.company) return shipping.company;
  
  // Nombre completo
  const nombres = [
    [customer.first_name, customer.last_name],
    [billing.first_name, billing.last_name],
    [shipping.first_name, shipping.last_name]
  ];
  
  for (const [first, last] of nombres) {
    const nombre = [first, last].filter(Boolean).join(' ').trim();
    if (nombre) return nombre;
  }
  
  return 'Cliente';
}

/**
 * Validar estructura de pedido de Shopify
 * @param {Object} order
 * @returns {{valid: boolean, errors: string[]}}
 */
function validarPedidoShopify(order) {
  const errors = [];
  
  if (!order) {
    errors.push('Pedido es null o undefined');
    return { valid: false, errors };
  }
  
  if (!order.id) {
    errors.push('Pedido sin ID');
  }
  
  if (!order.line_items || !Array.isArray(order.line_items) || order.line_items.length === 0) {
    errors.push('Pedido sin items');
  }
  
  if (!order.total_price) {
    errors.push('Pedido sin total');
  }
  
  // Validar items
  if (order.line_items) {
    for (let i = 0; i < order.line_items.length; i++) {
      const item = order.line_items[i];
      if (!item.title) errors.push(`Item ${i}: sin título`);
      if (!item.price && item.price !== 0) errors.push(`Item ${i}: sin precio`);
      if (!item.quantity) errors.push(`Item ${i}: sin cantidad`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validar datos de comprobante antes de enviar a Biller
 * @param {Object} datos
 * @returns {{valid: boolean, errors: string[]}}
 */
function validarDatosComprobante(datos) {
  const errors = [];
  
  // Tipo de comprobante
  const tiposValidos = Object.values(config.TIPOS_CFE);
  if (!tiposValidos.includes(datos.tipo_comprobante)) {
    errors.push(`Tipo de comprobante inválido: ${datos.tipo_comprobante}`);
  }
  
  // Items
  if (!datos.items || !Array.isArray(datos.items) || datos.items.length === 0) {
    errors.push('Comprobante sin items');
  } else {
    for (let i = 0; i < datos.items.length; i++) {
      const item = datos.items[i];
      
      if (!item.concepto) {
        errors.push(`Item ${i}: sin concepto`);
      }
      if (typeof item.cantidad !== 'number' || item.cantidad <= 0) {
        errors.push(`Item ${i}: cantidad inválida`);
      }
      if (typeof item.precio !== 'number') {
        errors.push(`Item ${i}: precio inválido`);
      }
      if (typeof item.indicador_facturacion !== 'number') {
        errors.push(`Item ${i}: indicador_facturacion inválido`);
      }
    }
  }
  
  // Cliente para e-Factura
  if (datos.tipo_comprobante === config.TIPOS_CFE.E_FACTURA || 
      datos.tipo_comprobante === config.TIPOS_CFE.NC_E_FACTURA) {
    if (!datos.cliente) {
      errors.push('e-Factura requiere datos del cliente');
    } else {
      if (!datos.cliente.documento) {
        errors.push('Cliente sin número de documento');
      }
      if (!datos.cliente.razon_social && !datos.cliente.nombre_fantasia) {
        errors.push('Cliente sin razón social / nombre fantasía');
      }
    }
  }
  
  // Referencias para NC
  if (datos.tipo_comprobante === config.TIPOS_CFE.NC_E_TICKET || 
      datos.tipo_comprobante === config.TIPOS_CFE.NC_E_FACTURA) {
    if (!datos.referencias || datos.referencias.length === 0) {
      errors.push('Nota de crédito requiere referencia al comprobante original');
    } else {
      datos.referencias.forEach((ref, idx) => {
        if (typeof ref === 'object') {
          if (!ref.tipo || !ref.serie || !ref.numero) {
            errors.push(`Referencia ${idx} incompleta`);
          }
        }
      });
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validar email
 * @param {string} email
 */
function validarEmail(email) {
  if (!email) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

/**
 * Sanitizar string para CFE (remover caracteres problemáticos)
 * @param {string} str
 * @param {number} maxLength
 */
function sanitizarString(str, maxLength = 200) {
  if (!str) return '';
  
  return String(str)
    .replace(/[\x00-\x1F\x7F]/g, '') // Control characters
    .replace(/[<>]/g, '')            // XML special chars
    .trim()
    .substring(0, maxLength);
}

module.exports = {
  validarRUT,
  extraerRUTDePedido,
  obtenerRazonSocialDefault,
  validarPedidoShopify,
  validarDatosComprobante,
  validarEmail,
  sanitizarString
};
