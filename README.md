# 🧾 Integración Shopify ↔ Biller v2.0

**Facturación electrónica automática para tiendas Shopify en Uruguay**

Emite automáticamente e-Tickets y e-Facturas cuando tus clientes compran en Shopify.

---

## 📊 Diagrama del Flujo

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                        FLUJO DE FACTURACIÓN AUTOMÁTICA                       ║
╚══════════════════════════════════════════════════════════════════════════════╝

┌─────────────────┐
│  👤 CLIENTE     │
│  Compra en tu   │
│  tienda Shopify │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────────────────────────────────────────┐
│  🛒 SHOPIFY     │     │  Datos del pedido:                                  │
│                 │────▶│  • Items: Camiseta x1 = $1,000                      │
│  Procesa pago   │     │  • IVA: $230                                        │
│  $1,230 UYU     │     │  • Email: cliente@email.com                         │
└────────┬────────┘     │  • RUT: 212222220019 (si lo ingresó)                │
         │              └─────────────────────────────────────────────────────┘
         │
         │ Webhook: orders/paid
         ▼
┌─────────────────┐
│  🖥️ TU SERVIDOR │
│  (Este código)  │
│                 │
│  Puerto: 3000   │
│  URL: ngrok     │
└────────┬────────┘
         │
         │ ¿Cliente ingresó RUT?
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐ ┌───────┐
│  NO   │ │  SÍ   │
│       │ │       │
│e-Tick │ │e-Fact │
│ (101) │ │ (111) │
└───┬───┘ └───┬───┘
    │         │
    └────┬────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────────────────────────────────────────┐
│  📄 BILLER      │     │  POST /v2/comprobantes/crear                        │
│                 │◀────│  {                                                  │
│  Emite CFE      │     │    tipo_comprobante: 101 o 111,                     │
│  con DGI        │     │    items: [...],                                    │
└────────┬────────┘     │    cliente: {rut, nombre} // solo si e-Factura      │
         │              │  }                                                  │
         │              └─────────────────────────────────────────────────────┘
         │
         │ Respuesta: {id, serie, numero, cae}
         ▼
┌─────────────────┐
│  ✅ RESULTADO   │
│                 │
│  • Comprobante  │
│    emitido      │
│  • PDF enviado  │
│    al cliente   │
│  • Pedido       │
│    marcado      │
└─────────────────┘


╔══════════════════════════════════════════════════════════════════════════════╗
║                          FLUJO DE DEVOLUCIÓN                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝

┌─────────────────┐
│  🔄 REEMBOLSO   │
│  en Shopify     │
└────────┬────────┘
         │
         │ Webhook: refunds/create
         ▼
┌─────────────────┐
│  🖥️ TU SERVIDOR │
│                 │
│  Busca CFE      │
│  original       │
└────────┬────────┘
         │
         │ ¿Original era e-Ticket o e-Factura?
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌───────┐ ┌───────┐
│NC     │ │NC     │
│e-Tick │ │e-Fact │
│ (102) │ │ (112) │
└───┬───┘ └───┬───┘
    │         │
    └────┬────┘
         │
         ▼
┌─────────────────┐
│  📄 BILLER      │
│                 │
│  Emite NC con   │
│  referencia al  │
│  CFE original   │
└─────────────────┘
```

---

## 🚀 Instalación Rápida

```bash
# 1. Navegar al directorio del proyecto
cd shopify-biller-integrationv2-[...]

# 2. Instalar dependencias
npm install

# 3. Crear archivo .env con tus credenciales
cp .env.example .env
# Edita .env y completa tus credenciales de Biller y Shopify

# 4. Iniciar servidor
npm start

# 5. Registrar webhooks (solo primera vez)
curl -X POST https://mercadolibre-biller-integrationv3.onrender.com/api/setup-webhooks
```

---

## 🔌 Servidor en Producción (Render)

La integración está desplegada en **Render** y corre 24/7:

**URL del servidor:** `https://mercadolibre-biller-integrationv3.onrender.com`

### Registrar webhooks (solo la primera vez o si cambió la URL)
```bash
curl -X POST https://mercadolibre-biller-integrationv3.onrender.com/api/setup-webhooks
```

### Verificar que todo funciona
```bash
# Ver estado general
curl https://mercadolibre-biller-integrationv3.onrender.com/?detailed=true

# Ver estado de webhooks
curl https://mercadolibre-biller-integrationv3.onrender.com/api/webhooks-status
```

---

## ⚙️ Tu Configuración Actual

El archivo `.env` ya viene configurado con tus credenciales:

| Variable | Valor | Descripción |
|----------|-------|-------------|
| `BILLER_TOKEN` | `XUEwFah7...` | Token de API Biller |
| `BILLER_EMPRESA_ID` | `413` | ID de tu empresa en Biller |
| `SHOPIFY_SHOP` | `tu-tienda` | Tu tienda Shopify |
| `SERVER_PUBLIC_URL` | `https://mercadolibre-biller-integrationv3.onrender.com` | URL de Render |

---

## 📋 Tipos de Comprobantes

| Situación | Tipo | Código | Descripción |
|-----------|------|--------|-------------|
| Venta sin RUT | e-Ticket | 101 | Consumidor final |
| Venta con RUT | e-Factura | 111 | Cliente con RUT/CI |
| Devolución e-Ticket | NC e-Ticket | 102 | Anula e-Ticket |
| Devolución e-Factura | NC e-Factura | 112 | Anula e-Factura |

---

## 🔌 Endpoints de la API

### Health & Status
```
GET /                    → Estado básico
GET /?detailed=true      → Estado con conexiones
GET /metrics             → Métricas detalladas
```

### Webhooks
```
POST /webhooks/shopify   → Recibe webhooks de Shopify (automático)
POST /api/setup-webhooks → Registrar webhooks en Shopify
GET  /api/webhooks-status → Ver estado de webhooks
```

### Facturación Manual
```
POST /api/facturar/:orderId     → Facturar un pedido específico
POST /api/facturar-pendientes   → Facturar todos los pendientes
```

### Comprobantes
```
GET  /api/comprobantes          → Listar comprobantes emitidos
GET  /api/comprobantes/stats    → Estadísticas
GET  /api/comprobante/:id/pdf   → Descargar PDF
POST /api/comprobante/:id/reenviar → Re-enviar por email
```

### Diagnóstico
```
GET /api/test-biller     → Verificar conexión con Biller
```

---

## 📁 Estructura del Proyecto

```
shopify-biller-pro/
│
├── server.js              # 🖥️  Servidor principal Express
│                          #     - Recibe webhooks de Shopify
│                          #     - Procesa pedidos y reembolsos
│                          #     - Expone API REST
│
├── biller-client.js       # 📄 Cliente para API de Biller
│                          #     - Emitir comprobantes
│                          #     - Validar RUT con DGI
│                          #     - Obtener PDFs
│
├── shopify-client.js      # 🛒 Cliente para API de Shopify
│                          #     - Gestionar webhooks
│                          #     - Marcar pedidos facturados
│                          #     - OAuth
│
├── config.js              # ⚙️  Configuración centralizada
│                          #     - Lee variables de .env
│                          #     - Constantes (tipos CFE, IVA, etc.)
│
├── utils/
│   ├── logger.js          # 📝 Sistema de logging con colores
│   ├── retry.js           # 🔄 Reintentos con backoff exponencial
│   ├── store.js           # 💾 Persistencia de comprobantes (JSON)
│   ├── queue.js           # 📬 Cola async con concurrencia limitada
│   ├── circuit-breaker.js # ⚡ Protección contra servicios caídos
│   └── validators.js      # ✅ Validación de RUT, pedidos, etc.
│
├── tests/
│   └── test.js            # 🧪 26 tests unitarios
│
├── data/
│   └── comprobantes.json  # 💾 Comprobantes emitidos (auto-generado)
│
├── .env                   # 🔐 TUS CREDENCIALES (ya configurado)
├── .env.example           # 📋 Template de configuración
├── package.json           # 📦 Dependencias npm
├── start.sh               # 🚀 Script de inicio con diagnóstico
├── README.md              # 📖 Esta documentación
├── CONFIGURAR-SHOPIFY.md  # 🛒 Guía para configurar campo RUT
└── SHOPIFY-ORDER-STATUS-SCRIPT.html # 📜 Script para mostrar PDF en checkout
```

---

## 📄 Mostrar Comprobante en Página de Confirmación

Para que tus clientes vean el link de descarga del PDF en la página de confirmación de pedido:

### Pasos:
1. Ve a **Shopify Admin → Settings → Checkout**
2. Busca la sección **"Order status page"** → **"Additional scripts"**
3. Abre el archivo `SHOPIFY-ORDER-STATUS-SCRIPT.html` de este proyecto
4. Copia TODO el contenido y pégalo en Additional scripts
5. **IMPORTANTE**: Verifica que `SERVER_URL` esté configurada correctamente:
   ```javascript
   var SERVER_URL = 'https://mercadolibre-biller-integrationv3.onrender.com';
   ```
6. Guarda los cambios

### Resultado:
Cuando un cliente complete una compra, verá en la página de confirmación:
- Un cuadro mostrando el número de comprobante (ej: "e-Ticket A-12345")
- Botón "Descargar PDF" para obtener el comprobante
- El CAE del comprobante

Si el comprobante aún está procesándose, verá un mensaje indicando que lo recibirá por email.

---

## 🛒 Configurar Campo RUT en Shopify

Para que tus clientes puedan ingresar su RUT y recibir e-Factura:

### Opción 1: Checkout Blocks (Shopify Plus)
1. Settings → Checkout → Customize
2. Agregar "Custom field"
3. Field ID: `rut`
4. Label: "RUT / CI (opcional para factura)"

### Opción 2: Nota del Pedido
El cliente escribe en notas: `RUT: 212222220019`

Ver guía completa en `CONFIGURAR-SHOPIFY.md`

---

## 🧪 Verificar que Funciona

### 1. Ejecutar tests
```bash
npm test
```
Deberías ver: `📊 Resultados: 26 passed, 0 failed`

### 2. Verificar conexiones
```bash
curl http://localhost:3000/?detailed=true
```

### 3. Verificar webhooks
```bash
curl http://localhost:3000/api/webhooks-status
```

### 4. Hacer compra de prueba
1. Ve a tu tienda: `https://test-biller.myshopify.com`
2. Compra un producto
3. Mira la consola del servidor:
```
📨 Webhook: orders/paid
✅ e-Ticket emitido: A-123
📧 Comprobante enviado
```

---

## 🔧 Troubleshooting

### "Token de Shopify inválido"
→ Regenera el Access Token en Shopify Admin → Apps → Develop apps

### "No llegan webhooks"
→ Verifica que ngrok esté corriendo
→ Ejecuta: `curl -X POST https://tu-url/api/setup-webhooks`

### "Error de conexión con Biller"
→ Verifica `BILLER_TOKEN` en `.env`
→ Prueba: `curl https://tu-url/api/test-biller`

### "Se emite e-Ticket en vez de e-Factura"
→ El cliente no ingresó RUT
→ Configura el campo RUT en checkout (ver `CONFIGURAR-SHOPIFY.md`)

---

## 📊 Ejemplo de Request a Biller

Cuando llega un pedido, el servidor envía esto a Biller:

```json
{
  "tipo_comprobante": 101,
  "empresa_id": 413,
  "id_externo": "shopify-5678901234",
  "items": [
    {
      "nombre": "Camiseta manga corta",
      "descripcion": "Camiseta manga corta",
      "cantidad": 1,
      "precio_unitario": 1000,
      "indicador_iva": 3,
      "unidad": "UN"
    }
  ],
  "formas_pago": [
    {
      "tipo": 2,
      "monto": 1230
    }
  ],
  "observaciones": "Pedido Shopify #1234"
}
```

Y Biller responde:

```json
{
  "id": 12345,
  "serie": "A",
  "numero": 123,
  "cae_numero": "90230001234567",
  "fecha_emision": "2024-12-02T15:30:00Z"
}
```

---

## ✅ Checklist Pre-Producción

- [ ] Tests pasan (`npm test`)
- [ ] Conexión Biller OK (`/api/test-biller`)
- [ ] Webhooks registrados (`/api/webhooks-status`)
- [ ] Compra de prueba emite comprobante
- [ ] PDF llega por email
- [ ] Campo RUT configurado en checkout
- [ ] Cambiar `BILLER_ENVIRONMENT=production` cuando estés listo

---

**Versión**: 2.0.0  
**Última actualización**: Diciembre 2024
