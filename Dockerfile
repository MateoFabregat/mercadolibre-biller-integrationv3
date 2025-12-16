# Shopify-Biller Integration - Dockerfile
# Facturación electrónica automática para Shopify en Uruguay

# Usar Node.js 20 LTS
FROM node:20-alpine

# Metadata
LABEL maintainer="shopify-biller"
LABEL description="Integración Shopify-Biller para facturación electrónica en Uruguay"
LABEL version="2.0.0"

# Crear directorio de trabajo
WORKDIR /app

# Crear usuario no-root para seguridad
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodeapp -u 1001 -G nodejs

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias (solo producción)
RUN npm ci --only=production && \
    npm cache clean --force

# Copiar código fuente
COPY --chown=nodeapp:nodejs . .

# Crear directorios necesarios
RUN mkdir -p data && \
    mkdir -p data/audit && \
    mkdir -p data/reconciliation-reports && \
    chown -R nodeapp:nodejs data

# Cambiar a usuario no-root
USER nodeapp

# Puerto por defecto
EXPOSE 3000

# Variables de entorno
ENV NODE_ENV=production
ENV SERVER_PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Comando de inicio
CMD ["node", "server.js"]
