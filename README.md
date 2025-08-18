# FortunaMoney Bot

Bot de Telegram para gestión de inversiones con sistema de referidos y ganancias diarias.

## 🚀 Configuración en Render.com

### 1. Variables de Entorno Obligatorias

En el panel de Render.com, configura las siguientes variables de entorno:

#### Bot y Base de Datos
- `BOT_TOKEN`: Token de tu bot de Telegram (obtenerlo de @BotFather)
- `SUPABASE_URL`: URL de tu proyecto Supabase
- `SUPABASE_KEY`: Clave pública de Supabase

#### Administración
- `ADMIN_ID`: Tu ID de Telegram (numérico)
- `ADMIN_GROUP_ID`: ID del grupo de administradores (debe incluir el - inicial para grupos)
- `PAYMENT_CHANNEL`: ID del canal público para notificaciones de pagos (opcional)

#### Servidor
- `HOST_URL`: URL de tu aplicación en Render (ej: https://tu-app.onrender.com)
- `WEBHOOK_SECRET`: Una clave secreta para el webhook (cualquier string aleatorio)
- `PORT`: 3000 (Render lo configura automáticamente)

#### Wallets y Configuración
- `WALLET_USDT`: Dirección de wallet USDT (BEP20)
- `WALLET_CUP`: Número de tarjeta para CUP
- `MIN_INVERSION`: Inversión mínima en USDT (default: 25)
- `RETIRO_FEE_USDT`: Fee de retiro en USDT (default: 1)
- `CUP_USDT_RATE`: Tasa de cambio CUP/USDT (default: 400)

### 2. Configuración del Deploy

#### Build Command
```bash
npm install
```

#### Start Command
```bash
npm start
```

### 3. Estructura de Base de Datos (Supabase)

Asegúrate de tener las siguientes tablas en Supabase:

#### `usuarios`
```sql
CREATE TABLE usuarios (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  patrocinador_id BIGINT REFERENCES usuarios(telegram_id),
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### `depositos`
```sql
CREATE TABLE depositos (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  monto DECIMAL(15,8) NOT NULL,
  moneda VARCHAR(10) NOT NULL,
  monto_origen DECIMAL(15,8) NOT NULL,
  tasa_usdt DECIMAL(8,2),
  estado VARCHAR(20) DEFAULT 'pendiente',
  ganado_disponible DECIMAL(15,8) DEFAULT 0,
  ganado_total DECIMAL(15,8) DEFAULT 0,
  acelerador_usado DECIMAL(15,8) DEFAULT 0,
  es_bono_referido BOOLEAN DEFAULT FALSE,
  fecha_creacion TIMESTAMP DEFAULT NOW(),
  fecha_aprobacion TIMESTAMP
);
```

#### `retiros`
```sql
CREATE TABLE retiros (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  monto DECIMAL(15,8) NOT NULL,
  moneda VARCHAR(10) NOT NULL,
  metodo VARCHAR(50) NOT NULL,
  destino TEXT NOT NULL,
  estado VARCHAR(20) DEFAULT 'pendiente',
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### `carteras`
```sql
CREATE TABLE carteras (
  telegram_id BIGINT PRIMARY KEY,
  saldo DECIMAL(15,8) DEFAULT 0,
  principal DECIMAL(15,8) DEFAULT 0,
  bruto DECIMAL(15,8) DEFAULT 0,
  bono DECIMAL(15,8) DEFAULT 0,
  ganado_total DECIMAL(15,8) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);
```

#### `tasa_diaria`
```sql
CREATE TABLE tasa_diaria (
  id SERIAL PRIMARY KEY,
  porcentaje DECIMAL(5,3) NOT NULL,
  fecha TIMESTAMP DEFAULT NOW()
);
```

### 4. Verificación Post-Deploy

1. **Acceder a la URL del webhook**: `https://tu-app.onrender.com/webhook`
2. **Probar el bot**: Envía `/start` a tu bot
3. **Verificar logs**: Revisa los logs en Render para errores
4. **Comando de diagnóstico**: Como admin, usa `/diagnostico` para verificar el estado

### 5. Comandos Administrativos

- `/pagarhoy` - Procesar pagos diarios
- `/porcentajedeldia <número>` - Establecer tasa del día
- `/porcentajehoy` - Ver tasa actual
- `/diagnostico` - Verificar estado del sistema

### 6. Solución de Problemas Comunes

#### El bot no responde
- Verificar que `BOT_TOKEN` sea correcto
- Verificar que el webhook esté configurado correctamente
- Revisar logs de Render

#### Error de base de datos
- Verificar `SUPABASE_URL` y `SUPABASE_KEY`
- Verificar que las tablas existan
- Verificar permisos de la clave pública

#### Error en notificaciones de canal
- Verificar que `PAYMENT_CHANNEL` sea correcto (incluir - para canales/grupos)
- Verificar que el bot sea administrador del canal
- Esta variable es opcional, el bot funcionará sin ella

#### El webhook no funciona
- Verificar que `HOST_URL` sea la URL correcta de Render
- Verificar que `WEBHOOK_SECRET` esté configurado
- Intentar reconfigurar visitando `/webhook`

### 7. Estructura del Proyecto

```
.
├── index.js              # Archivo principal del bot
├── package.json          # Dependencias del proyecto
├── .env.example          # Ejemplo de variables de entorno
└── README.md            # Este archivo
```

## 🔧 Desarrollo Local

1. Clonar el repositorio
2. Copiar `.env.example` a `.env`
3. Configurar todas las variables de entorno
4. Ejecutar `npm install`
5. Ejecutar `npm start`

## 📝 Funcionalidades

- ✅ Sistema de inversiones individuales con tope del 500%
- ✅ Tasa diaria dinámica configurable por admin
- ✅ Sistema de referidos con bono del 10%
- ✅ Acelerador que reduce el tope del 500% proporcional al bono
- ✅ Soporte para USDT (BEP20) y CUP (Tarjeta)
- ✅ Notificaciones automáticas a canal público
- ✅ Panel administrativo completo
- ✅ Manejo robusto de errores

## 📞 Soporte

Si tienes problemas con el deploy o configuración, revisa:
1. Los logs de Render.com
2. El comando `/diagnostico` en el bot
3. Las variables de entorno configuradas
