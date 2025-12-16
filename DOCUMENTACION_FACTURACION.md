# Flujo de facturación Shopify ↔ Biller v2

Resumen práctico para operación diaria y troubleshooting.

## Envío del comprobante al cliente
- Se envía **desde Biller**: al emitir el CFE se incluye `emails_notificacion` con el email del pedido. Biller envía el PDF directamente.
- Shopify no reenvía el comprobante fiscal; solo envía sus propios correos de pedido/pago.
- Si quieres sumar más destinatarios (copias), agrega correos en `emails_notificacion` o en `cliente.sucursal.emails` para e-Factura.
- Si ves un 404 al re-enviar manual (`/comprobantes/:id/enviar`), es porque ese endpoint no está disponible en tu ambiente v2; ya no lo usamos de forma automática y dependemos del envío en la emisión.

## Error “Página no encontrada” al enviar email
- Ocurría cuando se intentaba llamar al endpoint de envío manual (`/comprobantes/:id/enviar`), que devolvía 404.
- Se eliminó ese paso y ahora el envío va en la **misma emisión** (`emails_notificacion`), por lo que no deberías ver ese warning. Si no llega el correo:
  - Verifica que el email del pedido exista.
  - Revisa en Biller si el mail salió (historial / auditoría).
  - Prueba con otro correo o revisa la carpeta de spam.

## Cómo se emite y marca el pedido
- Webhook `orders/paid` → se construye el CFE con:
  - `numero_interno`: `shopify-<order_id>` (clave para idempotencia y búsquedas).
  - Items con `concepto`, `precio`, `indicador_facturacion`, `unidad_medida`.
  - `sucursal`: `BILLER_EMPRESA_SUCURSAL` del `.env`.
  - `emails_notificacion`: correo del pedido.
- Se marca el pedido en Shopify como facturado (tag/nota) y se guarda el comprobante en `data/comprobantes.json`.

## Cancelaciones / Notas de Crédito
- El flujo soportado es vía **refunds** en Shopify. Webhook `refunds/create` → genera NC:
  - `numero_interno`: `shopify-refund-<refund_id>`.
  - Referencia al comprobante original (`tipo/serie/numero`).
  - `emails_notificacion` con el correo del pedido original.
- Si cancelas un pedido, haz un **reembolso** en Shopify (total o parcial). Esa acción dispara la NC asociada al comprobante original.
- Si no hay refund, no hay NC (Shopify no envía webhook de cancelación puro).

## Configuración clave (.env)
- `BILLER_EMPRESA_SUCURSAL`: ID de sucursal en Biller (Ajustes → Sucursales). Necesario en cada emisión.
- `SERVER_PUBLIC_URL`: URL pública accesible (ngrok/https) para webhooks.
- `SHOPIFY_ACCESS_TOKEN`: requerido para webhooks y marcación de pedidos.

## Buenas prácticas
- Usa siempre refunds en Shopify para cualquier reverso; asegura la emisión de NC.
- Verifica que el email esté presente en el pedido para notificar automáticamente.
- Para pruebas, valida `/api/test-biller` y revisa la vista `/api/llamados` para ver el request de ejemplo v2.
