# 📋 Comandos del FortunaMoney Bot

Guía completa de todos los comandos disponibles en el bot, organizados por tipo de usuario y funcionalidad.

## 📑 Índice

- [Comandos de Usuario](#-comandos-de-usuario)
- [Comandos de Administrador](#-comandos-de-administrador)
- [Botones del Menú Principal](#-botones-del-menú-principal)
- [Botones Inline (Callbacks)](#-botones-inline-callbacks)
- [Estados de Conversación](#-estados-de-conversación)
- [Handlers de Contenido](#-handlers-de-contenido)
- [Ejemplos de Uso](#-ejemplos-de-uso)

---

## 👤 Comandos de Usuario

### `/start`
**Descripción**: Inicia el bot y registra al usuario
**Sintaxis**: 
- `/start` - Registro normal
- `/start ref_123456` - Registro como referido

**Funcionamiento**:
```javascript
// Extrae el ID del referidor del payload
const payload = ctx.startPayload || '';
const m = payload.match(/^ref_(\d+)$/i);
if (m) {
  sponsor = Number(m[1]);
  if (sponsor === uid) sponsor = null; // Evita auto-referido
}
await asegurarUsuario(uid, sponsor);
```

**Respuesta**:
```
🎉 ¡Bienvenido a FortunaMoney!
📋 Usa el menú de abajo para comenzar a invertir...
```

---

### `/menu`
**Descripción**: Muestra el menú principal del bot
**Sintaxis**: `/menu`

**Funcionamiento**:
```javascript
await ctx.reply('📋 Aquí tienes el menú principal:', menu());
```

**Respuesta**: Teclado con botones del menú principal

---

### `/ayuda` o `/help`
**Descripción**: Muestra la ayuda completa del bot
**Sintaxis**: `/ayuda` o `/help`

**Funcionamiento**: Envía mensaje extenso con:
- Opciones del menú explicadas
- Información importante del sistema
- Sistema de bonos de referido
- Comandos útiles
- Contacto de soporte

**Respuesta**:
```
🆘 AYUDA - FortunaMoney Bot

📋 Opciones del menú:
• Invertir - Realiza un depósito en USDT o CUP
• Retirar - Solicita un retiro de tus ganancias
• Saldo - Consulta tu balance actual
...
```

---

## 🔧 Comandos de Administrador

### `/pagarhoy`
**Descripción**: Ejecuta el pago diario a todas las inversiones activas
**Sintaxis**: `/pagarhoy`
**Restricción**: Solo ADMIN_ID

**Funcionamiento**:
```javascript
// 1. Obtiene la tasa del día actual
const tasaDelDia = await obtenerPorcentajeDelDia();
const rate = tasaDelDia / 100;

// 2. Obtiene todas las inversiones aprobadas (sin bonos)
const { data: inversiones } = await supabase
  .from('depositos')
  .select('*')
  .eq('estado', 'aprobado')
  .or('es_bono_referido.is.null,es_bono_referido.eq.false');

// 3. Para cada inversión
for (const inv of inversiones) {
  const montoBase = numero(inv.monto_origen);
  const tope = montoBase * 5; // 500%
  const ganadoTotal = numero(inv.ganado_total);
  
  // Verifica si no ha alcanzado el tope
  if (ganadoTotal < tope) {
    let pago = montoBase * rate;
    const margen = tope - ganadoTotal;
    if (pago > margen) pago = margen; // No exceder tope
    
    // Actualiza la inversión
    await supabase.from('depositos').update({
      ganado_disponible: ganadoDisponible + pago,
      ganado_total: ganadoTotal + pago
    }).eq('id', inv.id);
    
    // Notifica al usuario
    await bot.telegram.sendMessage(userId, 
      `💸 Pago acreditado: ${pago.toFixed(2)} ${moneda}`);
  }
}
```

**Respuesta**:
```
✅ /pagarhoy completado (Tasa: 1.5%).
Inversiones pagadas: 25
Total USDT: 123.45
Total CUP: 5600
```

---

### `/porcentajedeldia <porcentaje>`
**Descripción**: Establece la tasa de ganancias del día y notifica a usuarios
**Sintaxis**: `/porcentajedeldia 1.5`
**Restricción**: Solo ADMIN_ID

**Parámetros**:
- `porcentaje`: Número entre 0.1 y 10.0

**Funcionamiento**:
```javascript
const porcentaje = numero(argumento);
if (porcentaje <= 0 || porcentaje > 10) {
  return ctx.reply('El porcentaje debe ser mayor a 0 y máximo 10%');
}

// Guarda en base de datos
await establecerPorcentajeDelDia(porcentaje);

// Notifica a todos los usuarios activos
const notificados = await notificarNuevaTasa(porcentaje);
```

**Respuesta**:
```
✅ Porcentaje del día establecido: 1.5%
📨 Notificados: 47 usuarios
```

---

### `/porcentajehoy`
**Descripción**: Consulta la tasa actual del día
**Sintaxis**: `/porcentajehoy`
**Restricción**: Solo ADMIN_ID

**Funcionamiento**:
```javascript
const porcentaje = await obtenerPorcentajeDelDia();
await ctx.reply(`📊 Porcentaje del día: ${porcentaje}%`);
```

**Respuesta**:
```
📊 Porcentaje del día: 1.5%
```

---

## 🎯 Botones del Menú Principal

### **Invertir**
**Descripción**: Inicia el proceso de inversión
**Acción**: `bot.hears('Invertir')`

**Funcionamiento**:
```javascript
await ctx.reply('Elige método de inversión:', Markup.inlineKeyboard([
  [{ text: 'USDT (BEP20)', callback_data: 'inv:usdt' }],
  [{ text: 'CUP (Tarjeta)', callback_data: 'inv:cup' }],
]));
```

**Flujo**:
1. Usuario presiona "Invertir"
2. Bot muestra opciones USDT/CUP
3. Usuario selecciona moneda
4. Bot pide monto (`estado[chatId] = 'INV_USDT'`)
5. Usuario envía monto
6. Bot crea depósito pendiente
7. Bot envía instrucciones de pago
8. Usuario envía comprobante
9. Admin aprueba/rechaza

---

### **Retirar**
**Descripción**: Inicia el proceso de retiro
**Acción**: `bot.hears('Retirar')`

**Funcionamiento**:
```javascript
const saldos = await saldosPorMoneda(chatId);
const bonos = await carteraBonosDe(chatId);

// Verifica saldos disponibles
const tieneUSDT = saldos.USDT > 0 || bonos.saldo > 0;
const tieneCUP = saldos.CUP > 0;

if (!tieneUSDT && !tieneCUP) {
  return ctx.reply('❌ No tienes saldos disponibles para retirar.');
}

// Muestra opciones según saldos disponibles
const botones = [];
if (tieneUSDT) {
  botones.push([{ text: `Retirar USDT (${total})`, callback_data: 'ret:moneda:USDT' }]);
}
if (tieneCUP) {
  botones.push([{ text: `Retirar CUP (${total})`, callback_data: 'ret:moneda:CUP' }]);
}
```

**Flujo**:
1. Usuario presiona "Retirar"
2. Bot verifica saldos disponibles
3. Bot muestra opciones según monedas disponibles
4. Usuario selecciona moneda
5. Bot pide monto (`estado[chatId] = 'RET_USDT'`)
6. Usuario envía monto
7. Bot valida saldo suficiente
8. Bot pide método de cobro
9. Usuario selecciona método
10. Bot pide destino (`estado[chatId] = 'RET_DEST'`)
11. Usuario envía wallet/tarjeta
12. Bot crea retiro pendiente
13. Admin aprueba/rechaza

---

### **Saldo**
**Descripción**: Muestra todas las inversiones activas y progreso
**Acción**: `bot.hears('Saldo')`

**Funcionamiento**:
```javascript
// Obtiene inversiones individuales (sin bonos)
const inversiones = await inversionesDe(chatId, false);
const saldos = await saldosPorMoneda(chatId);
const bonos = await carteraBonosDe(chatId);

// Agrupa por moneda
const porMoneda = { USDT: [], CUP: [] };
for (const inv of inversiones) {
  porMoneda[inv.moneda].push(inv);
}

// Para cada inversión muestra:
for (const inv of porMoneda.USDT) {
  const progreso = progresoInversion(inv); // Calcula % al 500%
  const disponible = numero(inv.ganado_disponible);
  
  mensaje += `  • Inv #${inv.id}: ${monto} USDT\n`;
  mensaje += `    Disponible: ${disponible} USDT\n`;
  mensaje += `    Progreso: ${progreso}%\n`;
}
```

**Respuesta**:
```
📊 Tus Inversiones:

💵 USDT:
  • Inv #123: 100.00 USDT
    Disponible: 15.50 USDT
    Progreso: 15.5%
  🟢 Total USDT: 15.50

💎 Bonos de referidos:
  • USDT: 5.00 USDT

💡 Cada inversión tiene un tope del 500%
```

---

### **Referidos**
**Descripción**: Genera el enlace de referido personalizado
**Acción**: `bot.hears('Referidos')`

**Funcionamiento**:
```javascript
const uid = ctx.from.id;
const link = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
await ctx.reply(`Tu enlace de referido:\n${link}`);
```

**Respuesta**:
```
Tu enlace de referido:
https://t.me/fortunamoneybot?start=ref_123456789
```

---

### **Ganado total**
**Descripción**: Muestra el histórico completo de ganancias
**Acción**: `bot.hears('Ganado total')`

**Funcionamiento**:
```javascript
const inversiones = await inversionesDe(uid);
const bonos = await carteraBonosDe(uid);

let totalUSDT = 0;
let totalCUP = 0;

for (const inv of inversiones) {
  const ganado = numero(inv.ganado_total);
  if (inv.moneda === 'USDT') {
    totalUSDT += ganado;
  } else {
    totalCUP += ganado;
  }
}
```

**Respuesta**:
```
📈 Ganado total histórico:

💵 USDT: 245.67
💰 CUP: 12450
💎 Bonos: 35.80 USDT

*Esto incluye todo lo ganado desde el inicio.*
```

---

### **Tasa del día**
**Descripción**: Muestra la tasa actual de ganancias
**Acción**: `bot.hears('Tasa del día')`

**Funcionamiento**:
```javascript
const porcentaje = await obtenerPorcentajeDelDia();
```

**Respuesta**:
```
📊 Tasa del día actual:

🎯 1.5%

Esta es la tasa de ganancias que se aplicará a tus inversiones hoy.

💡 La tasa puede variar diariamente según las condiciones del mercado.
```

---

### **Histórico tasas**
**Descripción**: Muestra estadísticas de tasas por mes
**Acción**: `bot.hears('Histórico tasas')`

**Funcionamiento**:
```javascript
const historicoTasas = await obtenerHistoricoTasas();

// Agrupa por mes y calcula estadísticas
for (const registro of data) {
  const fecha = new Date(registro.fecha);
  const mesAno = `${fecha.getFullYear()}-${(fecha.getMonth() + 1).toString().padStart(2, '0')}`;
  
  // Calcula promedio, mínima, máxima, sumatoria
  tasasPorMes[mesAno].promedio = tasas.reduce((sum, tasa) => sum + tasa, 0) / tasas.length;
  tasasPorMes[mesAno].sumatoria = tasas.reduce((sum, tasa) => sum + tasa, 0);
  tasasPorMes[mesAno].minima = Math.min(...tasas);
  tasasPorMes[mesAno].maxima = Math.max(...tasas);
}
```

**Respuesta**:
```
📈 Histórico de tasas por mes:

📅 Enero 2025
   • Promedio: 1.65%
   • Sumatoria: 51.15%
   • Mínima: 1.00%
   • Máxima: 2.50%
   • Días con datos: 31

📅 Diciembre 2024
   • Promedio: 1.45%
   • Sumatoria: 44.95%
   • Mínima: 0.80%
   • Máxima: 2.00%
   • Días con datos: 31
```

---

## 🔘 Botones Inline (Callbacks)

### **Inversiones**

#### `inv:usdt`
**Descripción**: Selecciona USDT para inversión
**Acción**: `bot.action('inv:usdt')`

```javascript
const chatId = ctx.from.id;
estado[chatId] = 'INV_USDT';
await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION})`);
```

#### `inv:cup`
**Descripción**: Selecciona CUP para inversión
**Acción**: `bot.action('inv:cup')`

```javascript
const chatId = ctx.from.id;
estado[chatId] = 'INV_CUP';
await ctx.reply('Escribe el monto a invertir en CUP (mínimo 500)');
```

---

### **Retiros**

#### `ret:moneda:USDT`
**Descripción**: Selecciona USDT para retiro
**Acción**: `bot.action('ret:moneda:USDT')`

```javascript
const saldos = await saldosPorMoneda(uid);
const bonos = await carteraBonosDe(uid);
const disponible = saldos.USDT + bonos.saldo;

estado[uid] = 'RET_USDT';
await ctx.reply(`
💵 Retiro en USDT
Disponible: ${disponible.toFixed(2)} USDT
Fee de retiro: ${RETIRO_FEE_USDT} USDT
Escribe el monto a retirar`);
```

#### `ret:moneda:CUP`
**Descripción**: Selecciona CUP para retiro
**Acción**: `bot.action('ret:moneda:CUP')`

```javascript
const saldos = await saldosPorMoneda(uid);
estado[uid] = 'RET_CUP';
await ctx.reply(`
💰 Retiro en CUP
Disponible: ${saldos.CUP.toFixed(0)} CUP
*Sin fee de retiro para CUP*
Escribe el monto a retirar`);
```

#### `ret:m:usdt`
**Descripción**: Confirma método USDT para retiro
**Acción**: `bot.action('ret:m:usdt')`

```javascript
estado[uid] = 'RET_DEST';
await ctx.reply('Escribe tu wallet USDT (BEP20) donde quieres recibir el pago:');
```

#### `ret:m:cup`
**Descripción**: Confirma método CUP para retiro
**Acción**: `bot.action('ret:m:cup')`

```javascript
estado[uid] = 'RET_DEST';
await ctx.reply('Escribe el número de tu tarjeta CUP (16 dígitos):');
```

---

### **Administración de Depósitos**

#### `dep:approve:ID`
**Descripción**: Aprueba un depósito pendiente
**Acción**: `bot.action(/dep:approve:(\d+)/)`
**Restricción**: Solo ADMIN_ID o ADMIN_GROUP_ID

```javascript
const depId = Number(ctx.match[1]);
const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();

// Marca como aprobado
await supabase.from('depositos').update({ 
  estado: 'aprobado',
  fecha_aprobacion: new Date().toISOString()
}).eq('id', depId);

// Busca referidor y paga bono 10%
const { data: u } = await supabase.from('usuarios')
  .select('patrocinador_id')
  .eq('telegram_id', d.telegram_id)
  .maybeSingle();

const sponsorId = u?.patrocinador_id;
if (sponsorId && sponsorId !== d.telegram_id) {
  const bonoMonto = numero(d.monto_origen) * 0.10;
  await aplicarBonoReferido(sponsorId, bonoMonto, d.moneda);
}

// Notifica al usuario
await bot.telegram.sendMessage(d.telegram_id, 
  `✅ Inversión aprobada! Monto: ${d.monto_origen} ${d.moneda}`);
```

#### `dep:reject:ID`
**Descripción**: Rechaza un depósito pendiente
**Acción**: `bot.action(/dep:reject:(\d+)/)`
**Restricción**: Solo ADMIN_ID o ADMIN_GROUP_ID

```javascript
const depId = Number(ctx.match[1]);
await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
await ctx.reply(`Depósito #${depId} rechazado.`);
```

---

### **Administración de Retiros**

#### `ret:approve:ID`
**Descripción**: Aprueba un retiro pendiente
**Acción**: `bot.action(/ret:approve:(\d+)/)`
**Restricción**: Solo ADMIN_ID o ADMIN_GROUP_ID

```javascript
const rid = Number(ctx.match[1]);
const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();

const moneda = r.moneda || r.metodo;
const saldos = await saldosPorMoneda(r.telegram_id);
const bonos = await carteraBonosDe(r.telegram_id);

// Calcula total disponible
let disponible = saldos[moneda] || 0;
if (moneda === 'USDT') disponible += bonos.saldo;

const fee = moneda === 'USDT' ? RETIRO_FEE_USDT : 0;
const totalDebitar = r.monto + fee;

// Valida saldo suficiente
if (totalDebitar > disponible) {
  return ctx.answerCbQuery('Saldo insuficiente');
}

// Debita de inversiones y bonos
if (moneda === 'USDT') {
  // Primero de bonos, luego de inversiones
} else {
  // Solo de inversiones CUP
}

await supabase.from('retiros').update({ estado: 'aprobado' }).eq('id', rid);

// Notifica canal de pagos
await bot.telegram.sendMessage(PAYMENT_CHANNEL_ID, 
  `💸 RETIRO APROBADO\nID: #${rid}\nMonto: ${r.monto} ${moneda}`);
```

#### `ret:reject:ID`
**Descripción**: Rechaza un retiro pendiente
**Acción**: `bot.action(/ret:reject:(\d+)/)`
**Restricción**: Solo ADMIN_ID o ADMIN_GROUP_ID

```javascript
const rid = Number(ctx.match[1]);
await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);

// Notifica al usuario y canal de pagos sobre el rechazo
await bot.telegram.sendMessage(r.telegram_id, 
  `❌ Retiro rechazado\nID: #${rid}\nContacta al administrador`);
```

---

## 🔄 Estados de Conversación

El bot mantiene estados para conversaciones multi-paso:

### `INV_USDT`
**Activado por**: Botón "USDT (BEP20)" en inversión
**Espera**: Monto de inversión en USDT
**Validación**: 
```javascript
if (isNaN(monto) || monto < MIN_INVERSION) {
  await ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
}
```

### `INV_CUP`
**Activado por**: Botón "CUP (Tarjeta)" en inversión
**Espera**: Monto de inversión en CUP
**Validación**:
```javascript
if (isNaN(monto) || monto < 500) {
  await ctx.reply('El mínimo de inversión es 500 CUP.');
}
```

### `RET_USDT`
**Activado por**: Botón "Retirar USDT"
**Espera**: Monto de retiro en USDT
**Validación**:
```javascript
const totalDebitar = monto + RETIRO_FEE_USDT;
if (totalDebitar > disponible) {
  await ctx.reply(`Saldo insuficiente. Disponible: ${disponible} USDT`);
}
```

### `RET_CUP`
**Activado por**: Botón "Retirar CUP"
**Espera**: Monto de retiro en CUP
**Validación**:
```javascript
if (monto > disponible) {
  await ctx.reply(`Saldo insuficiente. Disponible: ${disponible} CUP`);
}
```

### `RET_ELIGE_METODO`
**Activado por**: Después de ingresar monto de retiro
**Espera**: Selección de método mediante botones
**Acción**: Ignora texto, solo acepta botones inline

### `RET_DEST`
**Activado por**: Selección de método de retiro
**Espera**: Wallet USDT o número de tarjeta CUP
**Procesamiento**:
```javascript
const draft = retiroDraft[uid]; // { monto, moneda }
const destino = txtRaw;

// Crea retiro pendiente
await supabase.from('retiros').insert([{
  telegram_id: uid,
  monto: draft.monto,
  moneda: draft.moneda,
  destino: destino,
  estado: 'pendiente'
}]);
```

---

## 📥 Handlers de Contenido

### `bot.on('text')`
**Descripción**: Procesa todos los mensajes de texto según el estado
**Funcionamiento**:

```javascript
bot.on('text', async (ctx, next) => {
  const chatId = ctx.from.id;
  const txtRaw = ctx.message?.text?.trim();
  const st = estado[chatId];

  // Si es comando, pasa a otros handlers
  if (txtRaw.startsWith('/')) return next();

  // Si no está en estado manejado, pasa a .hears()
  const estadosManejados = ['INV_USDT', 'INV_CUP', 'RET_USDT', 'RET_CUP', 'RET_DEST'];
  if (!estadosManejados.includes(st)) {
    if (!st) {
      await ctx.reply('😊 Utiliza las opciones del menú principal...', menu());
    }
    return;
  }

  // Procesa según el estado actual
  if (st === 'INV_USDT' || st === 'INV_CUP') {
    // Procesa monto de inversión
  } else if (st === 'RET_USDT' || st === 'RET_CUP') {
    // Procesa monto de retiro
  } else if (st === 'RET_DEST') {
    // Procesa destino de retiro
  }
});
```

### `bot.on('photo')`
**Descripción**: Recibe comprobantes de pago
**Funcionamiento**:

```javascript
bot.on('photo', async (ctx) => {
  const uid = ctx.from.id;
  const photos = ctx.message.photo || [];
  const best = photos[photos.length - 1]; // Mejor calidad
  const fileId = best.file_id;

  // Busca depósito pendiente más reciente
  const { data: dep } = await supabase.from('depositos')
    .select('id, estado')
    .eq('telegram_id', uid)
    .eq('estado', 'pendiente')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!dep) return ctx.reply('No encuentro un depósito pendiente.');

  // Guarda el comprobante
  await supabase.from('depositos')
    .update({ proof_file_id: fileId })
    .eq('id', dep.id);

  // Envía al grupo admin con botones
  await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
    caption: `🧾 DEPÓSITO\nID: ${dep.id}\nUser: ${uid}`,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Aprobar', callback_data: `dep:approve:${dep.id}` }],
      [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}` }]
    ]}
  });
});
```

---

## 📝 Ejemplos de Uso

### Ejemplo 1: Inversión Completa

```
Usuario: /start
Bot: 🎉 ¡Bienvenido a FortunaMoney!...

Usuario: [Presiona "Invertir"]
Bot: Elige método de inversión: [USDT] [CUP]

Usuario: [Presiona "USDT (BEP20)"]
Bot: Escribe el monto a invertir en USDT (mínimo 25)

Usuario: 100
Bot: ✅ Depósito creado (pendiente).
     ID: 123
     Monto: 100.00 USDT
     Wallet: TXn7...abc123
     • Envía el hash de la transacción

Usuario: [Envía foto del comprobante]
Bot: Comprobante guardado (#123).

[En grupo admin]
Bot: 🧾 DEPÓSITO ID: 123 User: 789012 [✅ Aprobar] [❌ Rechazar]

Admin: [Presiona "✅ Aprobar"]
Bot: Inversión aprobada: 100.00 USDT

Usuario: ✅ Inversión aprobada!
         💰 Monto: 100.00 USDT
         📊 ID de inversión: #123
         🎯 Tope máximo: 500% (500.00 USDT)
         ¡Comenzarás a recibir ganancias diarias!
```

### Ejemplo 2: Retiro Completo

```
Usuario: [Presiona "Retirar"]
Bot: 💰 Saldos disponibles para retiro:
     💵 USDT: 45.50
     [Retirar USDT (45.50)]

Usuario: [Presiona "Retirar USDT"]
Bot: 💵 Retiro en USDT
     Disponible: 45.50 USDT
     Fee de retiro: 1 USDT
     Escribe el monto a retirar

Usuario: 40
Bot: Elige método de cobro: [USDT (BEP20)]

Usuario: [Presiona "USDT (BEP20)"]
Bot: Escribe tu wallet USDT (BEP20) donde quieres recibir el pago:

Usuario: TXn7abc123def456ghi789
Bot: ✅ Retiro creado (pendiente).
     ID: 456
     Monto: 40.00 USDT
     Método: USDT
     Destino: TXn7abc123def456ghi789

[En grupo admin]
Bot: 🧾 RETIRO pendiente
     ID: #456
     Usuario: 789012
     Monto: 40.00 USDT
     [✅ Aprobar retiro] [❌ Rechazar retiro]

Admin: [Presiona "✅ Aprobar retiro"]
Bot: Retiro #456 aprobado.

Usuario: ✅ Retiro aprobado: 40.00 USDT
```

### Ejemplo 3: Sistema de Referidos

```
Usuario A: [Presiona "Referidos"]
Bot: Tu enlace de referido:
     https://t.me/fortunamoneybot?start=ref_123456

Usuario B: [Hace clic en el enlace]
Bot: 🎉 ¡Bienvenido a FortunaMoney! Has sido referido por otro usuario.

Usuario B: [Invierte 50 USDT y es aprobado]

Usuario A: 🎉 Bono de referido acreditado: 5.00 USDT
           Por el depósito de tu referido 789012.
           Este bono se ha sumado directamente al progreso 
           de tus inversiones activas de USDT.
```

### Ejemplo 4: Pago Diario del Admin

```
Admin: /porcentajedeldia 1.8
Bot: ✅ Porcentaje del día establecido: 1.8%
     📨 Notificados: 47 usuarios

[Usuarios reciben]
Bot: 📊 Tasa del día: 1.8% - ¡Prepárate para tus ganancias!

Admin: /pagarhoy
Bot: ✅ /pagarhoy completado (Tasa: 1.8%).
     Inversiones pagadas: 34
     Total USDT: 156.78
     Total CUP: 8920

[Usuarios reciben]
Bot: 💸 Pago acreditado: 1.80 USDT
     📊 Inversión #123 (Tasa del día: 1.8%)
```

---

## 🛡️ Validaciones y Seguridad

### Validaciones de Usuario
- **Montos mínimos**: 25 USDT, 500 CUP
- **Saldos suficientes**: Verificación antes de retiros
- **Anti auto-referido**: Usuario no puede referirse a sí mismo
- **Estados válidos**: Solo acepta input en estados correctos

### Validaciones de Admin
- **ID verificado**: Solo ADMIN_ID puede ejecutar comandos críticos
- **Grupo autorizado**: Solo ADMIN_GROUP_ID para aprobaciones
- **Rangos de porcentaje**: 0.1% - 10% para tasas diarias
- **Existencia de registros**: Verifica que depósitos/retiros existan

### Manejo de Errores
```javascript
try {
  // Operación crítica
} catch (e) {
  console.log('Error específico:', e);
  try { 
    await ctx.reply('Error procesando tu solicitud. Intenta de nuevo.'); 
  } catch {}
}
```

---

## 📊 Logging y Monitoreo

### Logs Importantes
```javascript
console.log('[BONO] sponsorId para', d.telegram_id, '=>', sponsorId);
console.log(`[BONO] Distribuidos ${bonoMonto} ${moneda} entre ${inversionesActivas.length} inversiones`);
console.log(`Inv #${inv.id}: +${pago.toFixed(2)} ${moneda} (tasa ${tasaDelDia}%)`);
console.log('START error:', e);
console.log('ERROR Saldo:', e);
```

### Notificaciones Automáticas
- **Depósitos pendientes** → Grupo admin
- **Retiros pendientes** → Grupo admin
- **Retiros aprobados** → Canal de pagos
- **Nuevas tasas** → Todos los usuarios activos
- **Pagos diarios** → Usuarios con inversiones

---

Esta guía cubre todos los comandos y funcionalidades del bot. Para implementación técnica, consultar el archivo `index.js` y el `README.md` principal.
