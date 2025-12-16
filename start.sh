#!/bin/bash

# ============================================================
# Script de inicio para Shopify-Biller Integration
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  🚀 SHOPIFY ↔ BILLER INTEGRATION v2.0${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Verificar Node.js
echo -e "${YELLOW}Verificando requisitos...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js no instalado${NC}"
    echo "   Instalar desde: https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js versión $NODE_VERSION detectada. Se requiere >= 18${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# Verificar npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm no instalado${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm $(npm -v)${NC}"

# Verificar node_modules
if [ ! -d "node_modules" ]; then
    echo ""
    echo -e "${YELLOW}Instalando dependencias...${NC}"
    npm install
fi
echo -e "${GREEN}✓ Dependencias instaladas${NC}"

# Verificar .env
if [ ! -f ".env" ]; then
    echo ""
    echo -e "${RED}❌ Archivo .env no encontrado${NC}"
    echo ""
    echo "   Copia .env.example a .env y configura tus credenciales:"
    echo ""
    echo "   cp .env.example .env"
    echo "   nano .env"
    echo ""
    exit 1
fi
echo -e "${GREEN}✓ Archivo .env existe${NC}"

# Cargar y verificar variables críticas
source .env 2>/dev/null || true

echo ""
echo -e "${YELLOW}Verificando configuración...${NC}"

ERRORS=0

# Biller
if [ -z "$BILLER_TOKEN" ]; then
    echo -e "${RED}❌ BILLER_TOKEN no configurado${NC}"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓ BILLER_TOKEN configurado${NC}"
fi

if [ -z "$BILLER_EMPRESA_ID" ]; then
    echo -e "${RED}❌ BILLER_EMPRESA_ID no configurado${NC}"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓ BILLER_EMPRESA_ID: $BILLER_EMPRESA_ID${NC}"
fi

# Shopify
if [ -z "$SHOPIFY_SHOP" ]; then
    echo -e "${RED}❌ SHOPIFY_SHOP no configurado${NC}"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓ SHOPIFY_SHOP: $SHOPIFY_SHOP${NC}"
fi

if [ -z "$SHOPIFY_API_KEY" ]; then
    echo -e "${RED}❌ SHOPIFY_API_KEY no configurado${NC}"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓ SHOPIFY_API_KEY configurado${NC}"
fi

if [ -z "$SHOPIFY_API_SECRET" ]; then
    echo -e "${RED}❌ SHOPIFY_API_SECRET no configurado${NC}"
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✓ SHOPIFY_API_SECRET configurado${NC}"
fi

if [ -z "$SHOPIFY_ACCESS_TOKEN" ]; then
    echo -e "${YELLOW}⚠ SHOPIFY_ACCESS_TOKEN no configurado${NC}"
    echo "   Visita /install para obtenerlo después de iniciar"
else
    echo -e "${GREEN}✓ SHOPIFY_ACCESS_TOKEN configurado${NC}"
fi

# Server
if [ -z "$SERVER_PUBLIC_URL" ] || [ "$SERVER_PUBLIC_URL" = "http://localhost:3000" ]; then
    echo -e "${YELLOW}⚠ SERVER_PUBLIC_URL no configurado${NC}"
    echo "   Actualiza con tu URL pública"
else
    echo -e "${GREEN}✓ SERVER_PUBLIC_URL: $SERVER_PUBLIC_URL${NC}"
fi

# Verificar errores críticos
if [ $ERRORS -gt 0 ]; then
    echo ""
    echo -e "${RED}❌ Hay $ERRORS errores de configuración${NC}"
    echo "   Edita .env y vuelve a ejecutar"
    exit 1
fi

# Crear directorio data si no existe
mkdir -p data

echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✓ Todo listo. Iniciando servidor...${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Tips
if [ -z "$SHOPIFY_ACCESS_TOKEN" ]; then
    echo -e "${YELLOW}📌 Después de iniciar, visita:${NC}"
    echo "   ${SERVER_PUBLIC_URL:-http://localhost:3000}/install"
    echo ""
fi

# Iniciar servidor
exec node server.js
