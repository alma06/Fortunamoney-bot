// ================== FortunaMoney Bot (con /pagarhoy libre) ==================
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
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID || 0);
const WALLET_USDT    = process.env.WALLET_USDT || 'WALLET_NO_CONFIGURADA';
const WALLET_CUP     = process.env.WALLET_CUP  || 'TARJETA_NO_CONFIGURADA';
const HOST_URL       = process.env.HOST_URL || '';
const PORT           = process.env.PORT || 3000;

// Reglas
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25); // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE  || 400); // 1 USDT = 400 CUP

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID) {
  console.log('Faltan variables de entorno obligatorias.');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado en memoria ========
const estado = {}; // valores: 'INV_USDT' | 'INV_CUP' | 'RET'

// ======== Helpers ========
function menu() {
  return Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
}

async function asegurarUsuario(telegram_id, referrer_id = null) {
  await supabase.from('usuarios').upsert(
    [{ telegram_id, referrer_id }],
    { onConflict: 'telegram_id' }
  );
  await supabase.from('carteras').upsert(
    [{ telegram_id, saldo: 0, principal: 0, bruto: 0 }],
    { onConflict: 'telegram_id' }
  );
}

async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, bruto')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  return {
    saldo: Number(data?.saldo ?? 0),
    principal: Number(data?.principal ?? 0),
    bruto: Number(data?.bruto ?? 0)
  };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);

  const row = {
    telegram_id,
    saldo: (patch.saldo !== undefined ? patch.saldo : cur.saldo),
    principal: (patch.principal !== undefined ? patch.principal : cur.principal),
    bruto: (patch.bruto !== undefined ? patch.bruto : cur.bruto)
  };

  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== UI Básica ========
bot.start(async (ctx) => {
  const args = ctx.message.text.split(" ");
  let referrer_id = null;
  if (args.length > 1) {
    referrer_id = Number(args[1]);
  }
  await asegurarUsuario(ctx.from.id, referrer_id);
  await ctx.reply('¡Bienvenido!', menu());
});

bot.hears('Saldo', async (ctx) => {
  const chatId = ctx.from.id;
  await asegurarUsuario(chatId);

  const { saldo, principal, bruto } = await carteraDe(chatId);
  const total = saldo + principal;
  const progreso = bruto ? (total / bruto * 100) : 0;

  await ctx.reply(
    'Tu saldo (en USDT):\n\n' +
    `Principal (invertido):  ${principal.toFixed(2)}\n` +
    `Disponible:             ${saldo.toFixed(2)}\n` +
    `Total:                  ${total.toFixed(2)}\n\n` +
    `Bruto (meta 500%):      ${bruto.toFixed(2)}\n` +
    `Progreso:               ${progreso.toFixed(2)}%`,
    menu()
  );
});

// ======== Referidos ========
bot.hears('Referidos', async (ctx) => {
  const uid = ctx.from.id;
  const link = `https://t.me/${ctx.botInfo.username}?start=${uid}`;
  await ctx.reply(
    `Tu enlace de referido:\n${link}\n\n` +
    `Ganas el 10% de la inversión inicial de tus referidos (se acredita en tu saldo disponible).`
  );
});

// ======== Invertir ========
bot.hears('Invertir', async (ctx) => {
  await ctx.reply('Elige método de inversión:', Markup.inlineKeyboard([
    [{ text: 'USDT (BEP20)', callback_data: 'inv:usdt' }],
    [{ text: 'CUP (Tarjeta)', callback_data: 'inv:cup' }],
  ]));
});

bot.action('inv:usdt', async (ctx) => {
  estado[ctx.from.id] = 'INV_USDT';
  await ctx.answerCbQuery();
  await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}).`);
});

bot.action('inv:cup', async (ctx) => {
  estado[ctx.from.id] = 'INV_CUP';
  await ctx.answerCbQuery();
  await ctx.reply('Escribe el monto a invertir en CUP (mínimo 500).');
});

// ======== Retirar ========
bot.hears('Retirar', async (ctx) => {
  const chatId = ctx.from.id;
  const car = await carteraDe(chatId);
  estado[chatId] = 'RET';
  await ctx.reply(
    `Tu saldo disponible es: ${car.saldo.toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de Texto ========
bot.on('text', async (ctx) => {
  const chatId = ctx.from.id;
  const st = estado[chatId];
  const monto = Number((ctx.message.text || '').replace(',', '.'));

  if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

  // Inversión
  if (st === 'INV_USDT' || st === 'INV_CUP') {
    let moneda = st === 'INV_USDT' ? 'USDT' : 'CUP';
    let montoFinal = st === 'INV_CUP' ? (monto / CUP_USDT_RATE) : monto;

    const ins = await supabase.from('depositos').insert([{
      telegram_id: chatId,
      monto: montoFinal,
      moneda,
      monto_origen: monto,
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) return ctx.reply('Error guardando depósito.');
    const depId = ins.data.id;

    await ctx.reply(
      `✅ Depósito creado (pendiente).\nID: ${depId}\nMonto: ${monto} ${moneda}\nEquivalente: ${montoFinal.toFixed(2)} USDT\n\nEnvía comprobante.`
    );

    await bot.telegram.sendMessage(ADMIN_GROUP_ID,
      `📩 DEPÓSITO pendiente\nID: #${depId}\nUser: ${chatId}\nMonto: ${monto} ${moneda}\nEq: ${montoFinal.toFixed(2)} USDT`, {
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Aprobar', callback_data: `dep:approve:${depId}` }],
          [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}` }]
        ]}
      });

    estado[chatId] = null;
    return;
  }

  // Retiro
  if (st === 'RET') {
    const car = await carteraDe(chatId);
    const totalDebitar = monto + RETIRO_FEE_USDT;
    if (totalDebitar > car.saldo) return ctx.reply('Saldo insuficiente.');

    const ins = await supabase.from('retiros').insert([{
      telegram_id: chatId,
      monto,
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) return ctx.reply('Error creando retiro.');
    const retId = ins.data.id;

    await ctx.reply(`✅ Retiro creado (pendiente). ID: ${retId}\nMonto: ${monto} USDT\nFee: ${RETIRO_FEE_USDT} USDT`);

    await bot.telegram.sendMessage(ADMIN_GROUP_ID,
      `🆕 RETIRO pendiente\nID: #${retId}\nUser: ${chatId}\nMonto: ${monto} USDT`, {
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Aprobar retiro', callback_data: `ret:approve:${retId}` }],
          [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}` }]
        ]}
      });

    estado[chatId] = null;
    return;
  }
});

// ======== Aprobar/Rechazar Depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  const depId = Number(ctx.match[1]);
  const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
  if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

  const car = await carteraDe(d.telegram_id);
  const nuevoPrincipal = car.principal + d.monto;
  const nuevoBruto     = nuevoPrincipal * 5; // 500% meta

  await actualizarCartera(d.telegram_id, { principal: nuevoPrincipal, bruto: nuevoBruto });
  await supabase.from('depositos').update({ estado: 'aprobado' }).eq('id', depId);

  // Pagar bono de referido (10%)
  const { data: user } = await supabase.from('usuarios').select('referrer_id').eq('telegram_id', d.telegram_id).maybeSingle();
  if (user?.referrer_id) {
    const bono = d.monto * 0.10;
    const refCar = await carteraDe(user.referrer_id);
    await actualizarCartera(user.referrer_id, { saldo: refCar.saldo + bono });
    await bot.telegram.sendMessage(user.referrer_id, `🎁 Has recibido ${bono.toFixed(2)} USDT por el referido #${d.telegram_id}`);
  }

  await bot.telegram.sendMessage(d.telegram_id, `✅ Depósito aprobado: ${d.monto.toFixed(2)} USDT\nInvertido: ${nuevoPrincipal.toFixed(2)}`);
  await ctx.editMessageReplyMarkup();
  await ctx.reply(`Depósito #${depId} aprobado.`);
});

// ======== Aprobar/Rechazar Retiro ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  const rid = Number(ctx.match[1]);
  const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
  if (!r || r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

  const car = await carteraDe(r.telegram_id);
  const totalDebitar = r.monto + RETIRO_FEE_USDT;
  if (totalDebitar > car.saldo) return ctx.answerCbQuery('Saldo insuficiente');

  await actualizarCartera(r.telegram_id, { saldo: car.saldo - totalDebitar });
  await supabase.from('retiros').update({ estado: 'aprobado' }).eq('id', rid);

  await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${r.monto.toFixed(2)} USDT`);
  await ctx.editMessageReplyMarkup();
  await ctx.reply(`Retiro #${rid} aprobado.`);
});

// ======== Pagar Hoy (manual, sin restricción) ========
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('No autorizado.');

  const { data: carteras } = await supabase.from('carteras').select('*');
  if (!carteras) return ctx.reply('No hay carteras.');

  let totalPagado = 0;
  for (const car of carteras) {
    if (car.principal <= 0) continue;

    const porcentaje = car.principal < 500 ? 0.015 : 0.02; // 1.5% o 2%
    const ganancia = car.principal * porcentaje;

    await actualizarCartera(car.telegram_id, { saldo: car.saldo + ganancia });
    await bot.telegram.sendMessage(car.telegram_id, `💰 Pago diario acreditado: ${ganancia.toFixed(2)} USDT`);

    totalPagado += ganancia;
  }

  await ctx.reply(`✅ Pago manual completado.\nTotal distribuido: ${totalPagado.toFixed(2)} USDT`);
});

// ======== Webhook ========
app.get('/', (_, res) => res.send('OK'));
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`HTTP on :${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
