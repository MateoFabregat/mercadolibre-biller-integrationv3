#!/usr/bin/env node
/**
 * 🔍 DIAGNÓSTICO DE LA INTEGRACIÓN SHOPIFY ↔ BILLER
 * 
 * Ejecutar: node diagnostico.js
 * 
 * Verifica:
 * 1. Variables de entorno
 * 2. Conexión con Biller
 * 3. Conexión con Shopify
 * 4. Estado de webhooks
 * 5. Prueba de facturación
 */

require('dotenv').config();

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function ok(msg) { console.log(`${GREEN}✅ ${msg}${RESET}`); }
function fail(msg) { console.log(`${RED}❌ ${msg}${RESET}`); }
function warn(msg) { console.log(`${YELLOW}⚠️  ${msg}${RESET}`); }
function info(msg) { console.log(`${BLUE}ℹ️  ${msg}${RESET}`); }
function header(msg) { console.log(`\n${BLUE}${'═'.repeat(60)}${RESET}\n${BLUE}  ${msg}${RESET}\n${BLUE}${'═'.repeat(60)}${RESET}`); }

async function main() {
  console.log('\n🔍 DIAGNÓSTICO DE INTEGRACIÓN SHOPIFY ↔ BILLER\n');
  
  let errores = 0;
  let advertencias = 0;

  // ============================================================
  // 1. VARIABLES DE ENTORNO
  // ============================================================
  header('1. VARIABLES DE ENTORNO');
  
  const envVars = {
    'BILLER_TOKEN': process.env.BILLER_TOKEN,
    'BILLER_EMPRESA_ID': process.env.BILLER_EMPRESA_ID,
    'SHOPIFY_SHOP': process.env.SHOPIFY_SHOP,
    'SHOPIFY_API_KEY': process.env.SHOPIFY_API_KEY,
    'SHOPIFY_API_SECRET': process.env.SHOPIFY_API_SECRET,
    'SHOPIFY_ACCESS_TOKEN': process.env.SHOPIFY_ACCESS_TOKEN,
    'SERVER_PUBLIC_URL': process.env.SERVER_PUBLIC_URL
  };

  for (const [key, value] of Object.entries(envVars)) {
    if (!value) {
      fail(`${key} no está configurado`);
      errores++;
    } else if (value.includes('TU-URL') || value.includes('tu-url')) {
      fail(`${key} tiene valor placeholder: ${value}`);
      errores++;
    } else {
      const display = key.includes('TOKEN') || key.includes('SECRET') 
        ? `${value.substring(0, 8)}...` 
        : value;
      ok(`${key} = ${display}`);
    }
  }

  // Verificar formato de URL
  const publicUrl = process.env.SERVER_PUBLIC_URL;
  if (publicUrl && !publicUrl.startsWith('https://')) {
    warn('SERVER_PUBLIC_URL debería usar HTTPS');
    advertencias++;
  }

  // ============================================================
  // 2. CONEXIÓN CON BILLER
  // ============================================================
  header('2. CONEXIÓN CON BILLER');
  
  const billerUrl = process.env.BILLER_ENVIRONMENT === 'production'
    ? 'https://biller.uy/v2'
    : 'https://test.biller.uy/v2';
  
  info(`Ambiente: ${process.env.BILLER_ENVIRONMENT || 'test'}`);
  info(`URL: ${billerUrl}`);

  try {
    // Probar conexión básica
    const response = await fetch(`${billerUrl}/comprobantes?limit=1`, {
      headers: {
        'Authorization': `Bearer ${process.env.BILLER_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      ok('Conexión con Biller exitosa');
      const data = await response.json();
      info(`Comprobantes en cuenta: ${data.total || data.length || 'N/A'}`);
    } else if (response.status === 401) {
      fail('Token de Biller inválido (401 Unauthorized)');
      errores++;
    } else if (response.status === 404) {
      warn(`Endpoint no encontrado (404) - puede ser normal en test`);
      // Intentar otro endpoint
      const testResp = await fetch(`${billerUrl}/empresas/${process.env.BILLER_EMPRESA_ID}`, {
        headers: { 'Authorization': `Bearer ${process.env.BILLER_TOKEN}` }
      });
      if (testResp.ok) {
        ok('Conexión alternativa exitosa');
      } else {
        warn('No se pudo verificar conexión completamente');
        advertencias++;
      }
    } else {
      warn(`Respuesta inesperada: ${response.status}`);
      advertencias++;
    }
  } catch (error) {
    fail(`Error de conexión: ${error.message}`);
    errores++;
  }

  // ============================================================
  // 3. CONEXIÓN CON SHOPIFY
  // ============================================================
  header('3. CONEXIÓN CON SHOPIFY');
  
  const shopDomain = process.env.SHOPIFY_SHOP.includes('.myshopify.com')
    ? process.env.SHOPIFY_SHOP
    : `${process.env.SHOPIFY_SHOP}.myshopify.com`;
  
  info(`Tienda: ${shopDomain}`);

  try {
    const shopifyUrl = `https://${shopDomain}/admin/api/2024-01/shop.json`;
    const response = await fetch(shopifyUrl, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      }
    });

    if (response.ok) {
      const data = await response.json();
      ok(`Conexión exitosa: ${data.shop.name}`);
      info(`Email: ${data.shop.email}`);
      info(`Plan: ${data.shop.plan_name}`);
    } else if (response.status === 401) {
      fail('Token de Shopify inválido (401 Unauthorized)');
      info('Solución: Regenerar token en Shopify Admin → Apps → Develop apps');
      errores++;
    } else {
      fail(`Error de Shopify: ${response.status}`);
      errores++;
    }
  } catch (error) {
    fail(`Error conectando a Shopify: ${error.message}`);
    errores++;
  }

  // ============================================================
  // 4. WEBHOOKS
  // ============================================================
  header('4. WEBHOOKS DE SHOPIFY');

  try {
    const webhooksUrl = `https://${shopDomain}/admin/api/2024-01/webhooks.json`;
    const response = await fetch(webhooksUrl, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
      }
    });

    if (response.ok) {
      const data = await response.json();
      const webhooks = data.webhooks || [];
      
      info(`Total webhooks: ${webhooks.length}`);
      
      const expectedUrl = `${publicUrl}/webhooks/shopify`;
      const ordersPaid = webhooks.find(w => w.topic === 'orders/paid');
      const refundsCreate = webhooks.find(w => w.topic === 'refunds/create');

      if (ordersPaid) {
        if (ordersPaid.address === expectedUrl) {
          ok(`orders/paid → ${ordersPaid.address}`);
        } else {
          warn(`orders/paid apunta a URL incorrecta:`);
          info(`  Actual:   ${ordersPaid.address}`);
          info(`  Esperado: ${expectedUrl}`);
          advertencias++;
        }
      } else {
        fail('Webhook orders/paid NO está configurado');
        errores++;
      }

      if (refundsCreate) {
        if (refundsCreate.address === expectedUrl) {
          ok(`refunds/create → ${refundsCreate.address}`);
        } else {
          warn(`refunds/create apunta a URL incorrecta`);
          advertencias++;
        }
      } else {
        warn('Webhook refunds/create no está configurado (opcional para NC)');
        advertencias++;
      }

      // Mostrar otros webhooks
      const otros = webhooks.filter(w => !['orders/paid', 'refunds/create'].includes(w.topic));
      if (otros.length > 0) {
        info(`Otros webhooks: ${otros.map(w => w.topic).join(', ')}`);
      }

    } else {
      fail(`Error obteniendo webhooks: ${response.status}`);
      errores++;
    }
  } catch (error) {
    fail(`Error verificando webhooks: ${error.message}`);
    errores++;
  }

  // ============================================================
  // 5. SERVIDOR LOCAL
  // ============================================================
  header('5. SERVIDOR LOCAL');

  try {
    const localUrl = `http://localhost:${process.env.SERVER_PORT || 3000}`;
    const response = await fetch(localUrl);
    
    if (response.ok) {
      const data = await response.json();
      ok(`Servidor corriendo en puerto ${process.env.SERVER_PORT || 3000}`);
      info(`Versión: ${data.version}`);
    } else {
      fail('Servidor no responde correctamente');
      errores++;
    }
  } catch (error) {
    warn('Servidor local no está corriendo');
    info('Ejecuta: npm start');
    advertencias++;
  }

  // ============================================================
  // 6. NGROK
  // ============================================================
  header('6. URL PÚBLICA (NGROK)');

  try {
    const response = await fetch(publicUrl);
    
    if (response.ok) {
      ok(`URL pública accesible: ${publicUrl}`);
    } else {
      warn(`URL responde con status ${response.status}`);
      advertencias++;
    }
  } catch (error) {
    fail(`URL pública NO accesible: ${publicUrl}`);
    info('Verifica que ngrok esté corriendo');
    errores++;
  }

  // ============================================================
  // RESUMEN
  // ============================================================
  header('RESUMEN');

  if (errores === 0 && advertencias === 0) {
    console.log(`\n${GREEN}🎉 ¡TODO OK! La integración está lista.${RESET}\n`);
  } else {
    console.log(`\n${errores > 0 ? RED : YELLOW}Errores: ${errores} | Advertencias: ${advertencias}${RESET}\n`);
    
    if (errores > 0) {
      console.log(`${RED}❌ Hay errores que deben corregirse antes de usar la integración.${RESET}\n`);
    }
  }

  // Comandos útiles
  header('COMANDOS ÚTILES');
  console.log(`
${BLUE}Registrar webhooks:${RESET}
  curl -X POST ${publicUrl}/api/setup-webhooks

${BLUE}Ver estado de webhooks:${RESET}
  curl ${publicUrl}/api/webhooks-status

${BLUE}Probar conexión Biller:${RESET}
  curl ${publicUrl}/api/test-biller

${BLUE}Facturar pedido manualmente:${RESET}
  curl -X POST ${publicUrl}/api/facturar/<ORDER_ID>

${BLUE}Ver comprobantes emitidos:${RESET}
  curl ${publicUrl}/api/comprobantes
`);

  process.exit(errores > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Error ejecutando diagnóstico:', err);
  process.exit(1);
});
