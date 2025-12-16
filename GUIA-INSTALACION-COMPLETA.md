# Guía de Instalación Completa: Shopify + Biller

## Integración de Facturación Electrónica para Uruguay

Esta guía te llevará paso a paso desde cero hasta tener tu tienda Shopify emitiendo comprobantes fiscales electrónicos (CFE) automáticamente con Biller.

---

## Tabla de Contenidos

1. [Requisitos Previos](#1-requisitos-previos)
2. [Configurar Cuenta en Biller](#2-configurar-cuenta-en-biller)
3. [Crear App en Shopify](#3-crear-app-en-shopify)
4. [Instalar la Integración](#4-instalar-la-integración)
5. [Configurar Variables de Entorno](#5-configurar-variables-de-entorno)
6. [Configurar ngrok (Desarrollo)](#6-configurar-ngrok-desarrollo)
7. [Ejecutar la Integración](#7-ejecutar-la-integración)
8. [Registrar Webhooks en Shopify](#8-registrar-webhooks-en-shopify)
9. [Probar la Integración](#9-probar-la-integración)
10. [Configurar Campo RUT en Shopify](#10-configurar-campo-rut-en-shopify-checkout)
11. [Personalizar la Integración](#11-personalizar-la-integración)
12. [Desplegar en Producción](#12-desplegar-en-producción)
13. [Monitoreo y Mantenimiento](#13-monitoreo-y-mantenimiento)
14. [Solución de Problemas](#14-solución-de-problemas)

---

## 1. Requisitos Previos

### Software Necesario

```bash
# Node.js 18+ (recomendado 20 LTS)
node --version  # Debe mostrar v18.x.x o superior

# npm (viene con Node.js)
npm --version

# Git
git --version
```

### Descargar Node.js
- **Windows/Mac**: https://nodejs.org/
- **Ubuntu/Debian**:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

### Cuentas Necesarias

1. **Cuenta Biller** con empresa configurada
2. **Tienda Shopify** con plan que permita apps personalizadas
3. **Cuenta ngrok** (gratis) para desarrollo: https://ngrok.com/

---

## 2. Configurar Cuenta en Biller

### 2.1 Crear Empresa en Biller

1. Ingresa a https:/biller.uy (producción) o https://test.biller.uy (test)
2. Ve a **Plan > Plan Grande**

### 2.2 Obtener Credenciales

Necesitarás:

| Dato | Dónde encontrarlo |
|------|-------------------|
| `BILLER_TOKEN` | Configuración > API > Token |
| `BILLER_EMPRESA_ID` | URL al ver la empresa (ej: `/empresas/123`) |
| `BILLER_EMPRESA_RUT` | Datos de la empresa |
| `BILLER_EMPRESA_SUCURSAL` | Configuración de sucursales (opcional) |

### 2.3 Verificar Conexión con DGI

Asegúrate que la empresa tenga:
- Certificado digital cargado
- CAE vigentes para e-Ticket (101), e-Factura (111), NC e-Ticket (102), NC e-Factura (112)

---

## 3. Crear App en Shopify

### 3.1 Acceder a Partner Dashboard o Admin

**Opción A: Desde Shopify Admin (más simple)**
1. Ve a tu tienda: `https://tu-tienda.myshopify.com/admin`
2. Settings > Apps and sales channels > Develop apps
3. Click "Allow custom app development" (si no está habilitado)
4. Click "Create an app"

**Opción B: Desde Partner Dashboard**
1. Ve a https://partners.shopify.com/
2. Apps > Create app > Create app manually

### 3.2 Configurar la App

1. **Nombre**: `Facturación Biller` (o el nombre que prefieras)

2. **Configuration > API access**:
   - Click "Configure Admin API scopes"
   - Selecciona estos permisos:
     ```
     read_orders
     write_orders
     read_customers
     read_products
     read_fulfillments
     read_checkouts
     ```

3. **Guarda los cambios**

### 3.3 Obtener Credenciales

1. Ve a **API credentials**
2. Copia:
   - **API key** → `SHOPIFY_API_KEY`
   - **API secret key** → `SHOPIFY_API_SECRET`

3. Click **Install app** para instalar en tu tienda
4. Después de instalar, copia el **Admin API access token** → `SHOPIFY_ACCESS_TOKEN`

> **IMPORTANTE**: El access token solo se muestra una vez. Si lo pierdes, debes reinstalar la app.

---

## 4. Instalar la Integración

### 4.1 Clonar el Repositorio

```bash
# Clonar
git clone https://github.com/tu-usuario/shopify-biller-integration.git

# Entrar al directorio
cd shopify-biller-integration

# Instalar dependencias
npm install
```

### 4.2 Estructura del Proyecto

```
shopify-biller-integration/
├── server.js              # Servidor principal
├── config.js              # Configuración centralizada
├── services/
│   ├── billing-decision.js    # Decisiones de facturación (Regla 5000 UI)
│   ├── credit-note-service.js # Notas de crédito
│   └── reconciliation-service.js # Reconciliación
├── utils/
│   ├── biller-api.js          # Cliente API Biller
│   ├── shopify-api.js         # Cliente API Shopify
│   ├── circuit-breaker-v2.js  # Circuit breaker
│   ├── biller-search-cache.js # Cache de búsquedas
│   ├── error-store.js         # Almacén de errores
│   └── audit-logger.js        # Logger de auditoría
├── workers/
│   └── pdf-sender-worker.js   # Worker para PDFs
├── public/
│   └── dashboard.html         # Dashboard visual
├── data/                  # Datos persistentes (se crea automáticamente)
├── .env.example           # Plantilla de variables
└── package.json
```

---

## 5. Configurar Variables de Entorno

### 5.1 Crear archivo .env

```bash
cp .env.example .env
```

### 5.2 Editar .env con tus valores

```env
# ============================================================
# BILLER - Facturación Electrónica
# ============================================================
BILLER_ENVIRONMENT=test          # Cambiar a 'production' para producción
BILLER_TOKEN=tu-token-aqui
BILLER_EMPRESA_ID=123
BILLER_EMPRESA_RUT=210000000000
BILLER_EMPRESA_SUCURSAL=          # Dejar vacío si no usas sucursales
BILLER_EMPRESA_NOMBRE=Mi Empresa SRL

# ============================================================
# SHOPIFY
# ============================================================
SHOPIFY_SHOP=mi-tienda            # Sin .myshopify.com
SHOPIFY_API_KEY=tu-api-key
SHOPIFY_API_SECRET=tu-api-secret
SHOPIFY_ACCESS_TOKEN=shpat_xxxxx
SHOPIFY_API_VERSION=2024-01

# ============================================================
# SERVIDOR
# ============================================================
SERVER_PORT=3000
SERVER_PUBLIC_URL=https://mercadolibre-biller-integrationv3.onrender.com

# ============================================================
# FACTURACIÓN
# ============================================================
VALIDAR_RUT_CON_DGI=true
ENVIAR_COMPROBANTE_CLIENTE=true
AGREGAR_LINK_EN_PEDIDO=true

# ============================================================
# REGLA 5000 UI (DGI Uruguay)
# ============================================================
LIMITE_UI_ETICKET=5000
VALOR_UI_UYU=6.0383              # Actualizar según BPC

# ============================================================
# OPCIONES AVANZADAS (pueden dejarse por defecto)
# ============================================================
LOG_LEVEL=info
RECONCILIATION_ENABLED=true
CACHE_TTL=300000
AUDIT_ENABLED=true
```

---

## 6. Configuración del Servidor (Render)

La integración está desplegada en **Render** con URL fija:

```env
SERVER_PUBLIC_URL=https://mercadolibre-biller-integrationv3.onrender.com
```

No necesitas ngrok en producción - Render proporciona una URL pública permanente.

---

## 7. Ejecutar la Integración

### 7.1 Iniciar el Servidor

```bash
npm start
```

### 7.2 Verificar que Funciona

Deberías ver:
```
[2024-01-15 10:30:00] INFO: Shopify-Biller Integration v2.1
[2024-01-15 10:30:00] INFO: Ambiente: test
[2024-01-15 10:30:00] INFO: Empresa: Mi Empresa SRL (RUT: 210000000000)
[2024-01-15 10:30:00] INFO: Dashboard: http://localhost:3000/dashboard
[2024-01-15 10:30:00] INFO: Límite e-Ticket: 30191.50 UYU (5000 UI)
[2024-01-15 10:30:00] INFO: Servidor escuchando en puerto 3000
```

### 7.3 Verificar Endpoints

```bash
# Health check
curl http://localhost:3000/health

# Dashboard (abrir en navegador)
open http://localhost:3000/dashboard
```

---

## 8. Registrar Webhooks en Shopify

### 8.1 Registrar Webhook de Pedidos Pagados

```bash
curl -X POST http://localhost:3000/webhooks/register
```

Respuesta esperada:
```json
{
  "success": true,
  "webhook": {
    "topic": "orders/paid",
    "address": "https://tu-dominio.ngrok-free.app/webhooks/orders/paid"
  }
}
```

### 8.2 Registrar Webhook de Reembolsos

```bash
curl -X POST http://localhost:3000/webhooks/register-refund
```

### 8.3 Verificar Webhooks

Puedes verificar en Shopify Admin:
- Settings > Notifications > Webhooks

O via API:
```bash
curl http://localhost:3000/webhooks/list
```

---

## 9. Probar la Integración

### 9.1 Crear Pedido de Prueba

1. Ve a tu tienda Shopify
2. Crea un pedido de prueba
3. Márcalo como pagado

### 9.2 Verificar Comprobante

1. Revisa los logs en la terminal
2. Ve al dashboard: http://localhost:3000/dashboard
3. Verifica en Biller que se creó el comprobante

### 9.3 Probar Diferentes Escenarios

| Escenario | Monto | RUT Cliente | Resultado Esperado |
|-----------|-------|-------------|-------------------|
| Venta pequeña sin RUT | $1,000 | - | e-Ticket (101) |
| Venta pequeña con RUT | $1,000 | 210000000000 | e-Factura (111) |
| Venta grande sin RUT | $50,000 | - | e-Ticket (101) + WARNING |
| Venta grande con RUT | $50,000 | 210000000000 | e-Factura (111) |

### 9.4 Probar Nota de Crédito

1. En Shopify, haz un reembolso parcial o total
2. Verifica que se emita NC (102 o 112)

---

## 10. Configurar Campo RUT en Shopify Checkout

Para emitir e-Facturas automáticamente, necesitas que tus clientes puedan ingresar su RUT/CI al momento de la compra.

### 10.1 Opciones Disponibles

| Opción | Dificultad | Plan Shopify |
|--------|------------|--------------|
| Checkout Blocks | Fácil | Shopify Plus |
| Cart Attributes | Media | Basic+ |
| Nota del pedido | Ninguna | Todos |

### 10.2 Opción A: Checkout Blocks (Shopify Plus)

1. **Admin > Settings > Checkout**
2. Click en **"Customize"** (esquina superior derecha)
3. En el editor de checkout, ir a la sección **"Information"**
4. Agregar bloque **"Custom field"**
5. Configurar:
   ```
   Label: RUT / CI (opcional - para factura)
   Field ID: rut
   Type: Text
   Required: No
   Placeholder: 8 o 12 dígitos
   ```
6. **Guardar**

**Campo opcional para Razón Social:**
Repite el proceso con:
```
Label: Razón Social
Field ID: razon_social
Type: Text
Required: No
```

### 10.3 Opción B: Cart Attributes (Todos los planes)

Editar tema > Archivo `cart.liquid` o `cart-template.liquid`

Buscar el `<form>` del carrito y agregar dentro:

```html
<div class="cart-attribute cart-attribute--rut">
  <label for="cart-rut">
    RUT / CI <small>(opcional - para factura)</small>
  </label>
  <input
    type="text"
    id="cart-rut"
    name="attributes[rut]"
    placeholder="Ej: 12345678 o 123456789012"
    pattern="[0-9]{8,12}"
    maxlength="12"
    value="{{ cart.attributes.rut }}"
  >
  <small class="cart-attribute__help">
    Ingresa tu CI (8 dígitos) o RUT (12 dígitos) si necesitas factura
  </small>
</div>

<div class="cart-attribute cart-attribute--razon-social" style="margin-top: 10px;">
  <label for="cart-razon-social">
    Razón Social <small>(opcional)</small>
  </label>
  <input
    type="text"
    id="cart-razon-social"
    name="attributes[razon_social]"
    placeholder="Nombre de la empresa"
    value="{{ cart.attributes.razon_social }}"
  >
</div>

<style>
.cart-attribute {
  margin: 15px 0;
}
.cart-attribute label {
  display: block;
  margin-bottom: 5px;
  font-weight: 500;
}
.cart-attribute input {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
}
.cart-attribute__help {
  color: #666;
  font-size: 12px;
}
</style>
```

### 10.4 Opción C: Nota del Pedido (Más simple)

El cliente escribe en "Notas del pedido":
```
RUT: 123456789012
```

El sistema detecta automáticamente formatos como:
- `RUT: 123456789012`
- `CI: 12345678`
- `Documento: 123456789012`

### 10.5 Cómo Funciona la Detección

El sistema busca el RUT en este orden:

1. **note_attributes** (campos del checkout)
   - Campos: `rut`, `RUT`, `rut_ci`, `documento`, `tax_id`, `ci`

2. **Nota del pedido** (order.note)
   - Formato: `RUT: XXXXXXXXXXXX` o `CI: XXXXXXXX`

3. **Company del cliente**
   - Si tiene formato de RUT (12 dígitos)

**Prioridad:** `note_attributes > nota del pedido > company`

### 10.6 Tipos de Documento

| Documento | Dígitos | tipo_doc | Comprobante |
|-----------|---------|----------|-------------|
| CI | 8 | 3 | e-Factura (111) |
| RUT | 12 | 2 | e-Factura (111) |
| Sin doc | - | - | e-Ticket (101) |

### 10.7 Verificar que Funciona

1. **Hacer pedido de prueba** con un RUT
2. **Verificar en Admin:** Orders > [Tu pedido] > Additional details
   ```
   rut: 123456789012
   ```
3. **Ver logs del servidor:**
   ```
   RUT detectado, emitiendo e-Factura {"rut":"123456789012"...}
   ```

### 10.8 Troubleshooting RUT

**El RUT no se detecta:**
- Verificar que el Field ID sea exactamente `rut` (minúsculas)
- Verificar que el cliente haya ingresado solo números

**Se emite e-Ticket en lugar de e-Factura:**
- Verificar longitud del RUT (debe ser 8 o 12 dígitos)
- DGI puede haber rechazado el RUT

**Error "RUT inválido":**
- El RUT debe existir en DGI
- Verificar dígito verificador correcto

### 10.9 Tips de Configuración

1. **Hacer el campo NO obligatorio** - No todos los clientes necesitan factura
2. **Agregar texto de ayuda** - Explicar para qué sirve
3. **Validar en frontend** - Usar `pattern` para solo números
4. **Probar con RUT real** - Usar RUT de tu empresa para testear

---

## 11. Personalizar la Integración

### 11.1 Personalizar Descripción de Items

Edita en `server.js` la función que procesa los items si necesitas formato especial:

```javascript
// Formato actual: "Nombre del producto x2"
// Para personalizar, busca la función processOrderItems
```

### 11.2 Personalizar Emails

El email al cliente incluye:
- Link al PDF del comprobante
- Número de comprobante

Para personalizar el texto, edita `utils/biller-api.js`.

---

## 12. Desplegar en Producción

### Opción A: Heroku

```bash
# Login en Heroku
heroku login

# Crear app
heroku create mi-tienda-biller

# Configurar variables
heroku config:set BILLER_ENVIRONMENT=production
heroku config:set BILLER_TOKEN=xxx
# ... (todas las variables de .env)

# Desplegar
git push heroku main

# Ver logs
heroku logs --tail
```

### Opción B: Docker

```bash
# Construir imagen
docker build -t shopify-biller .

# Ejecutar
docker run -d \
  --name shopify-biller \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data \
  shopify-biller
```

### Opción C: Docker Compose

```bash
docker-compose up -d
```

### Opción D: VPS (DigitalOcean, AWS, etc.)

1. Clonar repo en el servidor
2. Instalar Node.js
3. Configurar `.env`
4. Usar PM2 para mantener el proceso:

```bash
npm install -g pm2
pm2 start server.js --name "shopify-biller"
pm2 save
pm2 startup
```

### Configurar SSL/HTTPS

En producción necesitas HTTPS. Opciones:
- Cloudflare (gratis)
- Let's Encrypt con Nginx
- Load balancer de tu proveedor cloud

---

## 13. Monitoreo y Mantenimiento

### 13.1 Dashboard

Accede a `/dashboard` para ver:
- Comprobantes emitidos hoy/total
- Errores recientes
- Estado del circuit breaker
- Métricas de cache

### 13.2 Endpoints de Monitoreo

```bash
# Estado general
curl /health

# Métricas detalladas
curl /api/metrics

# Errores sin resolver
curl /api/errors

# Auditoría
curl /api/audit/recent

# Estado del circuit breaker
curl /api/circuit-breaker/status
```

### 13.3 Reconciliación

Verifica consistencia entre tu sistema y Biller:

```bash
# Reconciliación rápida (últimos 7 días)
curl /api/reconciliation/quick

# Reconciliación completa
curl -X POST /api/reconciliation/run
```

### 13.4 Logs

Los logs se guardan en:
- Consola (stdout)
- `data/audit.log` (acciones de facturación)
- `data/errors.json` (errores para resolver)

### 13.5 Actualizar Valor UI

El valor de la UI cambia. Actualiza `VALOR_UI_UYU` en `.env`:

```bash
# Consultar valor actual
# https://www.bps.gub.uy/10310/

# Actualizar .env
VALOR_UI_UYU=6.1234

# Reiniciar servidor
pm2 restart shopify-biller
```

---

## 14. Solución de Problemas

### Error: "Invalid API key or access token"

**Causa**: Credenciales de Shopify incorrectas

**Solución**:
1. Verifica `SHOPIFY_API_KEY` y `SHOPIFY_ACCESS_TOKEN`
2. Asegúrate que la app está instalada en la tienda
3. Regenera el access token si es necesario

### Error: "Webhook validation failed"

**Causa**: El secret no coincide

**Solución**:
1. Verifica `SHOPIFY_API_SECRET`
2. El webhook debe registrarse desde la misma instalación

### Error: "Circuit breaker is OPEN"

**Causa**: Muchos errores consecutivos con Biller

**Solución**:
1. Verifica conexión con Biller
2. Revisa logs para ver el error original
3. El circuito se cierra automáticamente después de 30 segundos

```bash
# Forzar reset del circuit breaker
curl -X POST /api/circuit-breaker/reset
```

### Error: "RUT inválido"

**Causa**: El RUT no tiene formato correcto o no existe en DGI

**Solución**:
1. Verificar formato: 12 dígitos
2. Verificar que existe en DGI
3. Si `VALIDAR_RUT_CON_DGI=true`, se valida automáticamente

### Los webhooks no llegan

**Causas posibles**:
1. ngrok no está corriendo
2. URL en webhook no coincide con `SERVER_PUBLIC_URL`
3. Firewall bloqueando

**Solución**:
1. Verificar que ngrok está activo
2. Re-registrar webhooks: `curl -X POST /webhooks/register`
3. Ver webhooks en Shopify Admin > Settings > Notifications

### Comprobante no se emite

**Revisar**:
1. Logs del servidor
2. Dashboard de errores: `/dashboard`
3. Estado en Biller

```bash
# Ver errores recientes
curl /api/errors

# Reintentar un comprobante específico
curl -X POST /api/retry-invoice/ORDER_ID
```

---

## Checklist de Implementación

### Antes de ir a Producción

- [ ] Probé con pedidos de prueba en ambiente test
- [ ] Verifiqué que se emiten e-Ticket y e-Factura correctamente
- [ ] Probé reembolsos y notas de crédito
- [ ] Configuré `BILLER_ENVIRONMENT=production`
- [ ] Tengo dominio/URL fija (no ngrok) para producción
- [ ] Configuré HTTPS
- [ ] Actualicé webhooks con URL de producción
- [ ] Configuré monitoreo/alertas
- [ ] Documenté credenciales de forma segura
- [ ] Hice backup de `data/comprobantes.json`

### Mantenimiento Mensual

- [ ] Verificar valor UI actualizado
- [ ] Revisar errores sin resolver
- [ ] Ejecutar reconciliación
- [ ] Verificar CAEs vigentes en Biller
- [ ] Revisar logs de auditoría

---

## Soporte

### Recursos

- **Documentación Biller**: https://docs.bfranco.com.uy
- **API Shopify**: https://shopify.dev/docs/api/admin-rest

### Contacto

- **Issues**: Reportar en el repositorio de GitHub
- **Biller soporte**: soporte@bfranco.com.uy

---

## Changelog

### v2.1 (2024)
- Regla 5000 UI implementada
- Dashboard visual en tiempo real
- Servicio de reconciliación
- Circuit breaker mejorado
- Cache de búsquedas Biller
- Sistema de auditoría
- Worker asíncrono para PDFs
- Soporte Docker/Heroku

### v2.0
- Arquitectura modular
- Mejor manejo de errores
- Notas de crédito automáticas

### v1.0
- Versión inicial
- e-Ticket y e-Factura básicos
