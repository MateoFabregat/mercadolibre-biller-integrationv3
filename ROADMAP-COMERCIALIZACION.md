# Roadmap de Comercialización: Shopify-Biller Integration

## Resumen Ejecutivo

Esta integración conecta tiendas Shopify con Biller para facturación electrónica automática en Uruguay. El objetivo es venderla como servicio desde Biller a comercios que usan Shopify.

---

## Estado Actual de la Integración

### Lo que YA funciona:
- Emisión automática de e-Tickets (101) y e-Facturas (111)
- Notas de crédito automáticas en reembolsos (102, 112)
- Detección de RUT/CI para elegir tipo de comprobante
- Validación de RUT con DGI
- Envío automático de PDF por email (via Biller)
- Manejo de productos, envíos y descuentos
- Almacenamiento local de comprobantes emitidos
- Reintentos automáticos y circuit breaker

### Lo que necesita cada cliente:
Solo configurar estas variables en `.env`:
```
BILLER_TOKEN=<su token de Biller>
BILLER_EMPRESA_ID=<su ID de empresa>
BILLER_EMPRESA_SUCURSAL=<su sucursal>
BILLER_EMPRESA_RUT=<RUT de la empresa>
BILLER_EMPRESA_NOMBRE=<Nombre de la empresa>

SHOPIFY_SHOP=<nombre-tienda>
SHOPIFY_API_KEY=<API key de la app>
SHOPIFY_API_SECRET=<API secret>
SHOPIFY_ACCESS_TOKEN=<token de acceso>

SERVER_PUBLIC_URL=<URL pública del servidor>
```

### Respuesta a tu pregunta:
**SÍ, funciona igual con nuevos productos y cambios de precios.** La integración lee los datos del pedido en tiempo real desde Shopify. No tiene catálogo propio ni precios hardcodeados.

---

## Modelos de Comercialización

### Opción A: Instalación Individual (Actual)
**Cada cliente tiene su propia instancia**

```
Cliente 1: servidor propio + ngrok/dominio → Biller
Cliente 2: servidor propio + ngrok/dominio → Biller
Cliente 3: servidor propio + ngrok/dominio → Biller
```

**Pros:**
- Ya funciona así
- Cada cliente controla su servidor
- Aislamiento total de datos

**Contras:**
- Cada cliente debe mantener servidor corriendo 24/7
- Requiere conocimiento técnico
- Difícil de escalar y dar soporte

**Esfuerzo:** Bajo (ya está listo)
**Precio sugerido:** $50-100 USD setup + soporte

---

### Opción B: SaaS Multi-Tenant (Recomendado)
**Un servidor central maneja múltiples tiendas**

```
                    ┌─────────────────────┐
Shopify Tienda 1 ──→│                     │
Shopify Tienda 2 ──→│  Servidor Central   │──→ Biller API
Shopify Tienda 3 ──→│  (tu infraestructura)│
                    └─────────────────────┘
```

**Pros:**
- Un solo servidor para todos
- Onboarding simple: solo conectar Shopify + dar token Biller
- Fácil de mantener y actualizar
- Modelo de suscripción mensual

**Contras:**
- Requiere desarrollo adicional
- Responsabilidad de uptime
- Costos de infraestructura

**Esfuerzo:** Medio (2-3 semanas de desarrollo)
**Precio sugerido:** $20-50 USD/mes por tienda

---

### Opción C: App de Shopify (Máxima Escala)
**Publicar en el App Store de Shopify**

**Pros:**
- Descubrimiento orgánico
- Instalación 1-click
- Máxima confianza del comercio

**Contras:**
- Proceso de revisión de Shopify
- Requiere cumplir estándares de Shopify
- 20% de comisión a Shopify
- Desarrollo significativo

**Esfuerzo:** Alto (1-2 meses)
**Precio sugerido:** $30-80 USD/mes

---

## Roadmap Recomendado: Opción B (SaaS)

### Fase 1: MVP Multi-Tenant (1-2 semanas)

#### 1.1 Base de Datos de Tenants
Reemplazar `.env` por base de datos:

```javascript
// Estructura de tenant
{
  id: "uuid",
  shopify_shop: "mi-tienda.myshopify.com",
  shopify_access_token: "shpat_xxx",
  biller_token: "xxx",
  biller_empresa_id: "123",
  biller_sucursal: "1",
  created_at: "2024-12-04",
  status: "active" // active, suspended, trial
}
```

**Opciones de BD:**
- SQLite (simple, sin servidor)
- PostgreSQL (robusto, escalable)
- MongoDB (flexible)

#### 1.2 Modificar Webhook Handler
El webhook debe identificar qué tenant corresponde:

```javascript
app.post('/webhooks/shopify', async (req, res) => {
  const shopDomain = req.get('X-Shopify-Shop-Domain');

  // Buscar tenant por dominio
  const tenant = await db.getTenantByShop(shopDomain);

  if (!tenant) {
    return res.status(404).send('Tienda no registrada');
  }

  // Procesar con credenciales del tenant
  await procesarPedido(req.body, tenant);
});
```

#### 1.3 Panel de Administración Simple
Dashboard web para:
- Registrar nuevos clientes
- Ver estado de cada integración
- Logs y estadísticas
- Suspender/activar clientes

#### 1.4 Onboarding Automatizado
Flujo de registro:
1. Cliente ingresa su tienda Shopify
2. OAuth para obtener access token automático
3. Cliente ingresa token de Biller
4. Se registran webhooks automáticamente
5. ¡Listo!

---

### Fase 2: Mejoras de Producto (2-4 semanas)

#### 2.1 Dashboard por Cliente
Cada cliente ve:
- Comprobantes emitidos
- Estadísticas (ventas, e-tickets vs e-facturas)
- Estado de la integración
- Historial de errores

#### 2.2 Notificaciones
- Email cuando hay error de emisión
- Alerta si el servidor de Biller no responde
- Resumen diario/semanal de facturación

#### 2.3 Configuraciones Avanzadas
Por cliente:
- Mapeo de productos a códigos Biller
- Reglas de IVA personalizadas
- Texto personalizado en comprobantes
- Múltiples sucursales

---

### Fase 3: Escala y Monetización (4-8 semanas)

#### 3.1 Billing y Suscripciones
- Integrar Stripe/MercadoPago para cobros
- Planes: Free trial → Básico → Pro
- Facturar automáticamente a clientes

#### 3.2 API Pública
Para integraciones avanzadas:
```
GET  /api/v1/comprobantes
POST /api/v1/comprobantes/emitir
GET  /api/v1/estadisticas
```

#### 3.3 Integraciones Adicionales
- WooCommerce
- TiendaNube
- PrestaShop
- API genérica para cualquier e-commerce

---

## Arquitectura Técnica Propuesta

```
┌─────────────────────────────────────────────────────────────────┐
│                         INFRAESTRUCTURA                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │   Shopify    │     │   Servidor   │     │    Biller    │    │
│  │   Tiendas    │────▶│   Node.js    │────▶│     API      │    │
│  │  (webhooks)  │     │   + Redis    │     │              │    │
│  └──────────────┘     └──────┬───────┘     └──────────────┘    │
│                              │                                   │
│                              ▼                                   │
│                       ┌──────────────┐                          │
│                       │  PostgreSQL  │                          │
│                       │  (tenants +  │                          │
│                       │ comprobantes)│                          │
│                       └──────────────┘                          │
│                                                                  │
│  Hosting: Railway / Render / DigitalOcean / AWS                 │
│  Costo estimado: $20-50 USD/mes                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Costos Estimados

### Desarrollo
| Fase | Tiempo | Costo (dev freelance) |
|------|--------|----------------------|
| Fase 1: MVP | 2 semanas | $1,500 - $3,000 USD |
| Fase 2: Dashboard | 3 semanas | $2,000 - $4,000 USD |
| Fase 3: Billing | 3 semanas | $2,000 - $4,000 USD |
| **Total** | **8 semanas** | **$5,500 - $11,000 USD** |

### Infraestructura Mensual
| Servicio | Costo |
|----------|-------|
| Servidor (Railway/Render) | $20-50 USD |
| Base de datos | $10-20 USD |
| Dominio + SSL | $15 USD/año |
| Monitoreo (opcional) | $10-20 USD |
| **Total mensual** | **$40-90 USD** |

### Punto de Equilibrio
- Con 5 clientes a $30/mes = $150/mes → Cubre infraestructura
- Con 20 clientes a $30/mes = $600/mes → Rentable
- Con 50 clientes a $30/mes = $1,500/mes → Muy rentable

---

## Modelo de Precios Sugerido

### Plan Starter - $25 USD/mes
- Hasta 100 comprobantes/mes
- e-Ticket + e-Factura
- Soporte por email

### Plan Pro - $50 USD/mes
- Hasta 500 comprobantes/mes
- Dashboard con estadísticas
- Soporte prioritario
- Múltiples sucursales

### Plan Enterprise - $100+ USD/mes
- Comprobantes ilimitados
- API acceso
- SLA garantizado
- Soporte dedicado

### Setup Fee (opcional)
- $50-100 USD por configuración inicial
- Incluye: onboarding, pruebas, capacitación

---

## Plan de Acción Inmediato

### Esta semana:
1. [ ] Decidir modelo (A, B, o C)
2. [ ] Validar con 2-3 clientes potenciales
3. [ ] Estimar demanda real

### Si eliges Opción B (SaaS):

#### Semana 1:
1. [ ] Configurar servidor en Railway/Render
2. [ ] Agregar SQLite/PostgreSQL para tenants
3. [ ] Modificar código para multi-tenant

#### Semana 2:
1. [ ] Crear flujo de onboarding OAuth
2. [ ] Panel admin básico
3. [ ] Deploy y pruebas

#### Semana 3:
1. [ ] Primer cliente beta (gratis)
2. [ ] Ajustes según feedback
3. [ ] Documentación de usuario

#### Semana 4:
1. [ ] Lanzar con pricing
2. [ ] Landing page simple
3. [ ] Empezar a vender

---

## Cambios de Código Necesarios (Opción B)

### 1. Nuevo archivo: `database.js`
```javascript
// Gestión de tenants con SQLite
const Database = require('better-sqlite3');
const db = new Database('tenants.db');

// Crear tabla
db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    shopify_shop TEXT UNIQUE,
    shopify_access_token TEXT,
    biller_token TEXT,
    biller_empresa_id TEXT,
    biller_sucursal TEXT,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = {
  getTenantByShop: (shop) => {
    return db.prepare('SELECT * FROM tenants WHERE shopify_shop = ?').get(shop);
  },
  createTenant: (tenant) => {
    // ...
  }
};
```

### 2. Modificar `server.js`
```javascript
// En el webhook handler
const tenant = await db.getTenantByShop(shopDomain);
const billerClient = new BillerClient(tenant.biller_token, tenant.biller_empresa_id);
const shopifyClient = new ShopifyClient(tenant.shopify_shop, tenant.shopify_access_token);
```

### 3. Nuevo endpoint de onboarding
```javascript
// GET /install?shop=tienda.myshopify.com
// POST /api/register (con token de Biller)
// GET /oauth/callback (recibe token de Shopify)
```

---

## Conclusión

**Recomendación:** Empezar con **Opción B (SaaS)** porque:

1. **Escala mejor** - Un servidor, múltiples clientes
2. **Menor fricción** - Cliente no necesita conocimiento técnico
3. **Ingresos recurrentes** - Modelo de suscripción mensual
4. **Control total** - Podés actualizar para todos a la vez
5. **Esfuerzo moderado** - 2-3 semanas para MVP funcional

El código actual es sólido y modular. Los cambios para multi-tenant son relativamente simples porque la lógica de negocio ya está bien separada.

---

## Próximos Pasos

1. **Confirmar interés:** ¿Hay clientes de Biller que usan Shopify y quieren esto?
2. **Validar precio:** ¿$25-50/mes es razonable para el mercado uruguayo?
3. **Decidir hosting:** Railway es simple, DigitalOcean da más control
4. **Empezar desarrollo:** Yo puedo ayudarte con los cambios de código

¿Querés que empiece a implementar la versión multi-tenant?