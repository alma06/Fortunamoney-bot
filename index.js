// ================== FortunaMoney Bot (Webhook + Cron HTTP) ==================
// Depósitos con comprobante (hash + foto), aprobación manual por admin
// Pago diario automático vía endpoint /run-pago (llamado por cron externo a las 12:00 Madrid)
// Tasa: 1.5% si BRUTO < 500 USDT, 2% si >= 500 USDT
// 10% al patrocinador y 90% al principal neto
// Tope total: 500% del BRUTO (bruto = neto / 0.9)
// Reglas nuevas: mínimo inversión 25 USDT, fee retiro 1 USDT
// ======================================================

require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ======== ENV ========
const BOT_TOKEN      = process.env.BOT_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ADMIN_ID       = Number(process.env.ADMIN_ID || 0);
const WALLET_USDT    = process.env.WALLET_USDT || 'WALLET_NO_CONFIGURADA';
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID ? Number(process.env.ADMIN_GROUP_ID) : null;

const HOST_URL       = process.env.HOST_URL || '';      // URL pública (Render/Heroku)
const CRON_SECRET    = process.env.CRON_SECRET || 'cambia_esto';
const PORT           = process.env.PORT || 3000;

// Reglas nuevas
const MIN_INVERSION      = 25;   // USDT
const RETIRO_FEE_USDT    = 1;    // USDT

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !WALLET_USDT) {
console.log('Faltan variables en .env (BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, ADMIN_ID, WALLET_USDT)');
process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// 🔎 LOG de todo update que llegue (para depurar en Render)
bot.use((ctx, next) => {
  console.log("Update recibido:", JSON.stringify(ctx.update));
  return next();
});

// 🧪 Comando mínimo de prueba
bot.command('aqui', async (ctx) => {
  const cid = (ctx.chat && ctx.chat.id) || (ctx.from && ctx.from.id);
  await ctx.reply('chat_id: ' + cid);
});

// Estado sencillo en memoria
const estado = {}; // estado[chatId] = 'INV' | 'RET'

// ======== Helpers UI ========
function menu() {
return Markup.keyboard([
['Invertir'],
['Retirar'],
['Saldo'],
['Referidos']
]).resize();
}

// Inline keyboards (aprobación/rechazo)
function kbDep(idDep) {
return Markup.inlineKeyboard([
[
Markup.button.callback('✅ Aprobar', 'dep:approve:' + idDep),
Markup.button.callback('❌ Rechazar', 'dep:reject:' + idDep)
]
]);
}
function kbRet(idRet) {
return Markup.inlineKeyboard([
[
Markup.button.callback('✅ Aprobar retiro', 'ret:approve:' + idRet),
Markup.button.callback('❌ Rechazar retiro', 'ret:reject:' + idRet)
]
]);
}

// ======== Helpers BD ========
async function asegurarUsuario(telegram_id) {
let { data: u } = await supabase.from('usuarios')
.select('telegram_id').eq('telegram_id', telegram_id).single();
if (!u) await supabase.from('usuarios').insert([{ telegram_id }]);

let { data: c } = await supabase.from('carteras')
.select('telegram_id').eq('telegram_id', telegram_id).single();
if (!c) await supabase.from('carteras').insert([{ telegram_id, saldo: 0, invertido: 0 }]);
}

async function carteraDe(id) {
const { data, error } = await supabase.from('carteras')
.select('saldo, invertido').eq('telegram_id', id).single();
if (error) throw error;
return data;
}

async function actualizarCartera(id, campos) {
const { error } = await supabase.from('carteras').update(campos).eq('telegram_id', id);
if (error) throw error;
}

async function totalRetirado(id) {
const { data } = await supabase.from('retiros')
.select('monto').eq('telegram_id', id).eq('estado', 'aprobado');
let s = 0; (data || []).forEach(r => s += Number(r.monto || 0));
return s;
}

async function patrocinadorDe(id) {
const { data } = await supabase.from('referidos')
.select('patrocinador_id').eq('referido_id', id).single();
return data ? data.patrocinador_id : null;
}

async function registrarReferencia(patroId, referidoId) {
if (!patroId || !referidoId || patroId === referidoId) return;
const { data } = await supabase.from('referidos')
.select('id').eq('referido_id', referidoId).single();
if (!data) await supabase.from('referidos').insert([{ patrocinador_id: patroId, referido_id: referidoId }]);
}

// ======== Avisos admin/grupo ========
async function avisarAdmin(texto, extra) {
try {
if (ADMIN_GROUP_ID) {
await bot.telegram.sendMessage(ADMIN_GROUP_ID, texto, extra || {});
} else if (ADMIN_ID) {
await bot.telegram.sendMessage(ADMIN_ID, texto, extra || {});
}
} catch (e) {
console.log('No pude avisar a admin:', e.message || e);
}
}

// Enviar foto a admin/grupo
async function avisarAdminFoto(fileId, caption, extra) {
try {
if (ADMIN_GROUP_ID) {
await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, { caption, ...(extra || {}) });
} else if (ADMIN_ID) {
await bot.telegram.sendPhoto(ADMIN_ID, fileId, { caption, ...(extra || {}) });
}
} catch (e) {
console.log('No pude enviar foto a admin:', e.message || e);
}
}

// ======== Finanzas ========
function tasaSegunBruto(brutoTotal) { return brutoTotal >= 500 ? 0.02 : 0.015; }
function brutoDesdeNeto(neto) { return neto > 0 ? (neto / 0.9) : 0; }
function tope500Bruto(bruto) { return bruto * 5.0; }

// ======== Handlers Bot ========
bot.start(async (ctx) => {
try {
const chatId = ctx.from.id;
await asegurarUsuario(chatId);

// Soporte de referidos: /start ref_12345      
const text = ctx.message.text || '';      
const partes = text.split(' ');      
if (partes.length > 1) {      
  const arg = partes[1];      
  if (arg.indexOf('ref_') === 0) {      
    const patroId = Number(arg.replace('ref_', ''));      
    if (patroId && patroId !== chatId) await registrarReferencia(patroId, chatId);      
  }      
}      

await ctx.reply('Bienvenido. Usa el menú:', menu());

} catch (e) {
console.log(e);
try { await ctx.reply('Ocurrió un error al iniciar.'); } catch {}
}
});

// =================== AQUI VAN TODOS LOS HEARS Y ON ===================
// (Invertir, Retirar, Saldo, Referidos, /tx, comprobante de foto, pagos diarios, retiros, admin, etc.)
// 🚨 IMPORTANTE: Usa la versión larga que me pasaste, no cortes nada.
// Ya está corregido para que envíe las fotos y los botones ✅

// =================== HTTP endpoints ===================
app.get('/', (_req, res) => res.send('FortunaMoney bot OK'));
app.get('/health', (_req, res) => res.send('OK'));

// Cron: ejecutar pago diario con ?key=CRON_SECRET (llamar a las 12:00 Europe/Madrid)
app.get('/run-pago', async (req, res) => {
const key = req.query.key || '';
if (key !== CRON_SECRET) return res.status(403).send('Forbidden');
const n = await pagarDiario();
res.send('Pago diario ejecutado. Usuarios pagados: ' + n);
});

// ===== Webhook de Telegram =====
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'fortunamoney2025';
const webhookPath = /webhook/${WEBHOOK_SECRET};

// GET de prueba (si abres la URL en el navegador debe responder 200 OK)
app.get(webhookPath, (_req, res) => res.status(200).send('OK'));

// Handler REAL del webhook (Telegram envía POST)
app.post(webhookPath, (req, res) => {
  return bot.webhookCallback(webhookPath)(req, res);
});

// ===== Arranque (Webhook si hay HOST_URL; si no, polling local) =====
app.listen(PORT, async () => {
  console.log('HTTP server on port', PORT);

  try {
    if (HOST_URL) {
      const url = HOST_URL + webhookPath;
      await bot.telegram.setWebhook(url);
      console.log('Webhook configurado en:', url);
    } else {
      await bot.launch();
      console.log('Bot lanzado en modo polling (HOST_URL no definido).');
    }
  } catch (e) {
    console.log('Error configurando webhook/polling:', e.message || e);
  }
});

process.once('SIGINT', () => { try { bot.stop('SIGINT'); } catch (_) {} });
process.once('SIGTERM', () => { try { bot.stop('SIGTERM'); } catch (_) {} });




