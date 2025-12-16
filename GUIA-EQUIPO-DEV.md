# Guía para Equipo de Desarrollo

## Integración Shopify-Biller v2.1

Esta guía proporciona instrucciones paso a paso para configurar y desplegar la integración.

---

## 1. Requisitos del Sistema

```bash
# Node.js 18+ (recomendado 20 LTS)
node --version  # v18.x.x o superior

# npm
npm --version

# git
git --version
```

---

## 2. Setup del Entorno Local

### 2.1 Clonar e Instalar

```bash
# Clonar repositorio
git clone <repo-url>
cd shopify-biller-integration

# Instalar dependencias
npm install

# Copiar archivo de configuración
cp .env.example .env
```

### 2.2 Estructura del Proyecto

```
shopify-biller-integration/
├── server.js                 # Servidor Express principal
├── config.js                 # Configuración centralizada
├── biller-client.js          # Cliente API Biller
├── shopify-client.js         # Cliente API Shopify
├── services/
│   ├── billing-decision.js   # Lógica de decisión e-Ticket/e-Factura
│   ├── credit-note-service.js # Notas de crédito
│   └── reconciliation-service.js # Reconciliación
├── utils/
│   ├── validators.js         # Validación RUT, pedidos
│   ├── store.js              # Persistencia comprobantes
│   ├── queue.js              # Cola asíncrona
│   ├── retry.js              # Reintentos con backoff
│   ├── circuit-breaker.js    # Circuit breaker v1
│   ├── circuit-breaker-v2.js # Circuit breaker v2 (mejorado)
│   ├── logger.js             # Sistema de logging
│   ├── error-store.js        # Almacén de errores
│   ├── audit-logger.js       # Logger de auditoría
│   └── biller-search-cache.js # Cache de búsquedas
├── workers/
│   └── pdf-sender-worker.js  # Worker asíncrono PDFs
├── public/
│   └── dashboard.html        # Dashboard visual
├── data/                     # Datos persistentes (auto-creado)
├── .env                      # Variables de entorno (NO commitear)
├── .env.example              # Plantilla de variables
└── package.json
```

---

## 3. Configuración de Credenciales

### 3.1 Biller

1. Acceder a https://test.biller.uy (test) o https://biller.uy (producción)
2. Crear empresa con RUT válido
3. Obtener credenciales:

| Variable | Ubicación en Biller |
|----------|---------------------|
| `BILLER_TOKEN` | Configuración > API > Token |
| `BILLER_EMPRESA_ID` | URL al ver empresa (ej: `/empresas/413`) |
| `BILLER_EMPRESA_RUT` | Datos de la empresa (12 dígitos) |
| `BILLER_EMPRESA_SUCURSAL` | Configuración > Sucursales (opcional) |

### 3.2 Shopify

1. Ir a tienda > Settings > Apps and sales channels > Develop apps
2. Crear app con nombre "Facturación Biller"
3. Configurar permisos:
   - `read_orders`, `write_orders`
   - `read_customers`, `read_products`
   - `read_fulfillments`
4. Obtener credenciales:

| Variable | Ubicación en Shopify |
|----------|----------------------|
| `SHOPIFY_SHOP` | Nombre de la tienda (sin .myshopify.com) |
| `SHOPIFY_API_KEY` | API credentials > API key |
| `SHOPIFY_API_SECRET` | API credentials > API secret key |
| `SHOPIFY_ACCESS_TOKEN` | Después de instalar la app |

### 3.3 ngrok (Desarrollo)

```bash
# Instalar
brew install ngrok  # Mac
# o descargar de https://ngrok.com/download

# Autenticar (obtener token en dashboard.ngrok.com)
ngrok config add-authtoken TU_TOKEN

# Crear dominio estático (gratis 1)
# En: dashboard.ngrok.com/cloud-edge/domains

# Usar dominio fijo
ngrok http 3000 --domain=tu-dominio.ngrok-free.app
```

---

## 4. Archivo .env

```env
# ============================================================
# BILLER
# ============================================================
BILLER_ENVIRONMENT=test
BILLER_TOKEN=tu-token-aqui
BILLER_EMPRESA_ID=413
BILLER_EMPRESA_RUT=170227220010
BILLER_EMPRESA_SUCURSAL=491
BILLER_EMPRESA_NOMBRE=Tu Empresa

# ============================================================
# SHOPIFY
# ============================================================
SHOPIFY_SHOP=tu-tienda
SHOPIFY_API_KEY=tu-api-key
SHOPIFY_API_SECRET=tu-api-secret
SHOPIFY_ACCESS_TOKEN=shpat_xxx

# ============================================================
# SERVIDOR
# ============================================================
SERVER_PORT=3000
SERVER_PUBLIC_URL=https://tu-dominio.ngrok-free.app

# ============================================================
# FACTURACIÓN
# ============================================================
VALIDAR_RUT_CON_DGI=true
ENVIAR_COMPROBANTE_CLIENTE=true
AGREGAR_LINK_EN_PEDIDO=true

# ============================================================
# REGLA 5000 UI
# ============================================================
LIMITE_UI_ETICKET=5000
VALOR_UI_UYU=6.0383

# ============================================================
# OPCIONES AVANZADAS
# ============================================================
LOG_LEVEL=info
MAX_CONCURRENT_WEBHOOKS=3
DEDUPE_WINDOW=300000
```

---

## 5. Ejecutar el Servidor

### 5.1 Desarrollo

```bash
# Terminal 1: ngrok
ngrok http 3000 --domain=tu-dominio.ngrok-free.app

# Terminal 2: servidor
npm start
# o con auto-reload:
npm run dev
```

### 5.2 Verificar que Funciona

```bash
# Health check
curl http://localhost:3000/

# Health check detallado
curl "http://localhost:3000/?detailed=true"

# Métricas
curl http://localhost:3000/metrics

# Test conexión Biller
curl http://localhost:3000/api/test-biller
```

---

## 6. Registrar Webhooks

```bash
# Configurar webhooks automáticamente
curl -X POST http://localhost:3000/api/setup-webhooks

# Verificar estado
curl http://localhost:3000/api/webhooks-status
```

**Webhooks registrados:**
- `orders/paid` → Emite comprobante automáticamente
- `refunds/create` → Emite nota de crédito

---

## 7. Endpoints Disponibles

### 7.1 Core

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/metrics` | Métricas del sistema |
| GET | `/dashboard` | Dashboard visual |
| GET | `/install` | Iniciar OAuth Shopify |
| GET | `/auth/callback` | Callback OAuth |

### 7.2 Comprobantes

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/comprobantes` | Listar todos |
| GET | `/api/comprobantes/stats` | Estadísticas |
| GET | `/api/comprobante/:id/pdf` | Descargar PDF |
| GET | `/api/comprobante/orden/:orderId` | Buscar por pedido |
| POST | `/api/facturar/:orderId` | Facturar pedido específico |
| POST | `/api/facturar-pendientes` | Facturar todos los pendientes |
| POST | `/api/comprobante/:id/reenviar` | Reenviar por email |

### 7.3 Errores

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/errors/unresolved` | Errores sin resolver |
| GET | `/api/errors/by-type?type=X` | Filtrar por tipo |
| GET | `/api/errors/by-order/:orderId` | Errores de un pedido |
| GET | `/api/errors/stats` | Estadísticas de errores |
| POST | `/api/errors/:id/resolve` | Marcar como resuelto |

### 7.4 Reconciliación

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/reconciliation/quick` | Reconciliación rápida (últimos 100) |
| POST | `/api/reconciliation/full` | Reconciliación completa |
| GET | `/api/reconciliation/reports` | Listar reportes |
| GET | `/api/reconciliation/report/:id` | Ver reporte específico |

### 7.5 Auditoría

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/audit/recent?hours=24` | Logs recientes |
| GET | `/api/audit/by-order/:orderId` | Logs de un pedido |
| GET | `/api/audit/stats?days=7` | Estadísticas |

### 7.6 Servicios

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/billing-decision/stats` | Estadísticas decisiones |
| POST | `/api/billing-decision/update-ui` | Actualizar valor UI |
| GET | `/api/cache/stats` | Estadísticas cache |
| POST | `/api/cache/clear` | Limpiar cache |
| GET | `/api/pdf-worker/stats` | Estadísticas worker PDF |
| GET | `/api/pdf-worker/failed` | Jobs fallidos |
| POST | `/api/pdf-worker/retry/:jobId` | Reintentar job |

---

## 8. Flujo de Facturación

```
┌──────────────────────────────────────────────────────────────┐
│ 1. PEDIDO PAGADO EN SHOPIFY                                  │
│    - Shopify envía webhook orders/paid                       │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. VERIFICACIÓN HMAC                                         │
│    - Valida firma del webhook                                │
│    - Responde 200 OK inmediatamente (< 5s)                   │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. DEDUPLICACIÓN                                             │
│    - Evita procesar el mismo webhook dos veces               │
│    - Ventana de 5 minutos                                    │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. PROCESAMIENTO ASÍNCRONO                                   │
│                                                              │
│    a) Validar estructura del pedido                          │
│    b) Verificar si ya facturado (tag "facturado")            │
│    c) Buscar RUT del cliente (múltiples fuentes)             │
│    d) Validar RUT con DGI si encontrado                      │
│    e) Determinar tipo: e-Ticket (101) o e-Factura (111)      │
│    f) Convertir pedido a formato Biller                      │
│    g) Emitir comprobante en Biller                           │
│    h) Guardar en store local                                 │
│    i) Marcar pedido como facturado en Shopify                │
│    j) Agregar nota con link al PDF                           │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ 5. COMPROBANTE EMITIDO                                       │
│    - ID, Serie, Número, CAE                                  │
│    - PDF disponible en Biller                                │
│    - Email enviado al cliente (si configurado)               │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. Tipos de Comprobante

| Código | Tipo | Cuándo se usa |
|--------|------|---------------|
| 101 | e-Ticket | Venta sin RUT o monto < 5000 UI |
| 102 | NC e-Ticket | Reembolso de e-Ticket |
| 111 | e-Factura | Venta con RUT válido |
| 112 | NC e-Factura | Reembolso de e-Factura |

### Regla 5000 UI (DGI Uruguay)
- Ventas > 5000 UI (~$30,000 UYU) requieren identificación del comprador
- Si no hay RUT, se emite e-Ticket pero se genera warning
- Actualizar `VALOR_UI_UYU` mensualmente según BPC

---

## 10. Detección de RUT

El sistema busca el RUT del cliente en orden de prioridad:

1. **note_attributes** del pedido
   - Campos: `rut`, `RUT`, `ci`, `CI`, `documento`, `tax_id`

2. **Metafields** del pedido

3. **Properties** de line_items

4. **Nota del pedido** (order.note)
   - Formatos: `RUT: 123456789012`, `CI: 12345678`

5. **Company** del cliente
   - Si contiene 12 dígitos que parecen RUT

---

## 11. Troubleshooting

### Webhook no llega

```bash
# Verificar que ngrok está corriendo
curl https://tu-dominio.ngrok-free.app/

# Re-registrar webhooks
curl -X POST http://localhost:3000/api/setup-webhooks

# Ver webhooks en Shopify Admin
# Settings > Notifications > Webhooks
```

### Error "Circuit breaker is OPEN"

```bash
# Ver estado
curl http://localhost:3000/metrics | jq '.circuit'

# El circuito se cierra automáticamente después de 30s
# O reiniciar el servidor
```

### Comprobante no se emite

```bash
# Ver errores recientes
curl http://localhost:3000/api/errors/unresolved

# Ver logs de auditoría del pedido
curl http://localhost:3000/api/audit/by-order/ORDER_ID

# Facturar manualmente
curl -X POST http://localhost:3000/api/facturar/ORDER_ID
```

### RUT no detectado

1. Verificar que el campo sea exactamente `rut` (minúsculas)
2. Verificar que solo contenga números (8 o 12 dígitos)
3. Verificar en logs: `RUT detectado...` o `Sin RUT, emitiendo e-Ticket`

---

## 12. Producción

### Checklist Pre-Deploy

- [ ] `BILLER_ENVIRONMENT=production`
- [ ] `SERVER_PUBLIC_URL` con URL de producción (HTTPS)
- [ ] Dominio fijo (no ngrok)
- [ ] SSL/HTTPS configurado
- [ ] Webhooks registrados con URL de producción
- [ ] Probado: e-Ticket, e-Factura, Nota de Crédito
- [ ] Valor UI actualizado
- [ ] Backup de `data/comprobantes.json`

### Deploy con Docker

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

### Deploy con Docker Compose

```bash
docker-compose up -d
```

### Deploy en Heroku

```bash
heroku create mi-tienda-biller
heroku config:set BILLER_ENVIRONMENT=production
heroku config:set BILLER_TOKEN=xxx
# ... (todas las variables)
git push heroku main
```

---

## 13. Mantenimiento

### Actualizar Valor UI

```bash
# El valor UI cambia mensualmente
# Consultar: https://www.bps.gub.uy/10310/

# Opción 1: Editar .env y reiniciar
VALOR_UI_UYU=6.1234

# Opción 2: API (temporal, hasta reinicio)
curl -X POST http://localhost:3000/api/billing-decision/update-ui \
  -H "Content-Type: application/json" \
  -d '{"valorUI": 6.1234}'
```

### Ejecutar Reconciliación

```bash
# Reconciliación rápida (últimos 100 comprobantes)
curl -X POST http://localhost:3000/api/reconciliation/quick

# Reconciliación completa
curl -X POST http://localhost:3000/api/reconciliation/full

# Ver reportes
curl http://localhost:3000/api/reconciliation/reports
```

### Limpiar Cache

```bash
curl -X POST http://localhost:3000/api/cache/clear
```

### Reintentar PDFs Fallidos

```bash
# Ver jobs fallidos
curl http://localhost:3000/api/pdf-worker/failed

# Reintentar uno específico
curl -X POST http://localhost:3000/api/pdf-worker/retry/JOB_ID
```

---

## 14. Contacto y Soporte

- **Issues**: Reportar en el repositorio de GitHub
- **Documentación Biller**: https://docs.biller.uy
- **API Shopify**: https://shopify.dev/docs/api/admin-rest
