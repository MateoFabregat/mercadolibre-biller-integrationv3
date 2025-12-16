#*🚀 Guía Rápida para Demo*
Necesitas 2 terminales abiertas:
Terminal 1: ngrok (expone tu servidor a internet)

ngrok http 3000 --domain=transnatural-infortunately-rodrigo.ngrok-free.dev
Si no tienes ese dominio configurado, usa: ngrok http 3000 y después actualiza SERVER_PUBLIC_URL en el .env
Terminal 2: Servidor

cd /Users/mateofabregat/Downloads/shopify-biller-integrationv2-cc2e541d666fd6175926cea46a63cfffdd9a454c

npm install   # solo la primera vez
npm start
Después de levantar ambos, registra los webhooks (solo 1 vez):

curl -X POST https://transnatural-infortunately-rodrigo.ngrok-free.dev/api/setup-webhooks
Credenciales ya configuradas en .env:
Servicio	Credenciales
Biller	Token: XUEwFah7ufvo9n4tpKAi, Empresa ID: 413, Ambiente: test
Shopify	Tienda: test-biller, Token: shpat_7da56cec619686ab190b2...
ngrok	Dominio: transnatural-infortunately-rodrigo.ngrok-free.dev
Para la demo, verifica que todo funciona:

# Health check
curl http://localhost:3000/

# Test conexión Biller
curl http://localhost:3000/api/test-biller

# Ver dashboard visual
open http://localhost:3000/dashboard
Flujo de demo:
Abre el dashboard: http://localhost:3000/dashboard
Crea un pedido de prueba en Shopify (test-biller.myshopify.com)
Marca el pedido como pagado → el webhook llega automáticamente
Ve cómo se emite el comprobante en el dashboard en tiempo real
Consulta estadísticas: curl http://localhost:3000/api/comprobantes/stats

