# 🛒 Configurar Campo RUT en Shopify Checkout

Esta guía explica cómo agregar un campo para que tus clientes puedan ingresar su RUT/CI al momento de la compra, permitiendo emitir e-Facturas automáticamente.

## 📋 Opciones Disponibles

| Opción | Dificultad | Plan Shopify |
|--------|------------|--------------|
| Checkout Blocks | Fácil | Shopify Plus |
| Custom Liquid | Media | Basic+ |
| Cart Attributes | Fácil | Basic+ |
| Nota del pedido | Ninguna | Todos |

---

## Opción 1: Checkout Blocks (Shopify Plus)

### Pasos:

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

### Campo opcional para Razón Social:

Repite el proceso con:
```
Label: Razón Social
Field ID: razon_social
Type: Text
Required: No
```

---

## Opción 2: Cart Attributes (Todos los planes)

### Editar tema > Archivo cart.liquid o cart-template.liquid

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

---

## Opción 3: Nota del Pedido

La opción más simple: el cliente escribe su RUT en las notas del pedido.

### En el checkout:

El cliente escribe en "Notas del pedido":
```
RUT: 123456789012
```

### El sistema detecta automáticamente:

- `RUT: 123456789012`
- `CI: 12345678`
- `Documento: 123456789012`

---

## 🔍 Cómo Funciona la Detección

El sistema busca el RUT en este orden:

1. **note_attributes** (campos del checkout)
   - Campos: `rut`, `RUT`, `rut_ci`, `documento`, `tax_id`, `ci`

2. **Nota del pedido** (order.note)
   - Formato: `RUT: XXXXXXXXXXXX` o `CI: XXXXXXXX`

3. **Company del cliente**
   - Si tiene formato de RUT (12 dígitos)

### Prioridad:
```
note_attributes > nota del pedido > company
```

---

## ✅ Verificar que Funciona

### 1. Hacer pedido de prueba

Completa una compra de prueba ingresando un RUT.

### 2. Verificar en Admin

**Orders > [Tu pedido]**

Buscar en la sección "Additional details":
```
rut: 123456789012
```

### 3. Ver logs del servidor

```bash
# Buscar en la salida del servidor
RUT detectado, emitiendo e-Factura {"rut":"123456789012"...}
```

---

## 📊 Tipos de Documento

| Documento | Dígitos | tipo_doc | Comprobante |
|-----------|---------|----------|-------------|
| CI | 8 | 3 | e-Factura (111) |
| RUT | 12 | 2 | e-Factura (111) |
| Sin doc | - | - | e-Ticket (101) |

---

## 🚨 Troubleshooting

### El RUT no se detecta

1. Verificar que el Field ID sea exactamente `rut` (minúsculas)
2. Verificar que el cliente haya ingresado solo números
3. Revisar logs del servidor

### Se emite e-Ticket en lugar de e-Factura

1. Verificar longitud del RUT (debe ser 8 o 12 dígitos)
2. Verificar que VALIDAR_RUT_CON_DGI=true en .env
3. Puede que DGI rechazó el RUT

### Error "RUT inválido"

1. El RUT debe existir en DGI
2. Verificar que el dígito verificador sea correcto
3. Probar con otro RUT conocido

---

## 💡 Tips

1. **Hacer el campo NO obligatorio** - No todos los clientes necesitan factura
2. **Agregar texto de ayuda** - Explicar para qué sirve
3. **Validar en frontend** - Usar pattern para solo números
4. **Probar con RUT real** - Usar RUT de tu empresa para testear
