// ================== FortunaMoney Bot (compacto) ==================
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

function numero(x) {
  return Number(x || 0);
}

async function asegurarUsuario(telegram_id) {
  await supabase.from('usuarios').upsert([{ telegram_id }], { onConflict: 'telegram_id' });
  await supabase.from('carteras').upsert([{ telegram_id, saldo: 0, principal: 0 }], { onConflict: 'telegram_id' });
}

async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, invertido, bruto')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  const saldo   = Number(data?.saldo ?? 0) || 0;
  const prinRaw = (data?.principal !== undefined ? data.principal : data?.invertido);
  const principal = Number(prinRaw ?? 0) || 0;
  const bruto  = Number(data?.bruto ?? 0) || 0;

  return { saldo, principal, bruto };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);

  const nuevoSaldo     = (patch.saldo     !== undefined) ? patch.saldo     : cur.saldo;
  const nuevoPrincipal = (patch.principal !== undefined) ? patch.principal : cur.principal;
  const nuevoBruto     = (patch.bruto     !== undefined) ? patch.bruto     : cur.bruto;

  const row = {
    telegram_id,
    saldo: nuevoSaldo,
    principal: nuevoPrincipal,
    invertido: nuevoPrincipal,
    bruto: nuevoBruto
  };

  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== UI Básica ========
bot.start(async (ctx) => {
  await asegurarUsuario(ctx.from.id);
  await ctx.reply('¡Bienvenido!', menu());
});

bot.hears('Saldo', async (ctx) => {
  const chatId = ctx.from.id;
  await asegurarUsuario(chatId);

  const { saldo = 0, principal = 0, bruto = 0 } = await carteraDe(chatId);
  const total = Number(saldo) + Number(principal);
  const progreso = bruto ? (total / bruto * 100) : 0;

  await ctx.reply(
    'Tu saldo (en USDT):\n\n' +
    `Principal (invertido):  ${principal.toFixed(2)}\n` +
    `Disponible:             ${saldo.toFixed(2)}\n` +
    `Total:                  ${total.toFixed(2)}\n\n` +
    `Bruto (base para 500%): ${bruto.toFixed(2)}\n` +
    `Progreso hacia 500%:    ${progreso.toFixed(2)}%`,
    menu()
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
    `Tu saldo disponible es: ${numero(car.saldo).toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de Texto (monto) ========
bot.on('text', async (ctx) => {
  const chatId = ctx.from.id;
  const st = estado[chatId];
  const txt = (ctx.message.text || '').replace(',', '.');
  const monto = Number(txt);
  if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

  // --- Inversión ---
  if (st === 'INV_USDT' || st === 'INV_CUP') {
    let moneda = st === 'INV_USDT' ? 'USDT' : 'CUP';
    let montoFinal = monto;
    let tasa_usdt = null;
    if (st === 'INV_CUP') {
      tasa_usdt = CUP_USDT_RATE;
      montoFinal = monto / tasa_usdt;
    }

    const ins = await supabase.from('depositos').insert([{
      telegram_id: chatId,
      monto: montoFinal,
      moneda,
      monto_origen: monto,
      tasa_usdt,
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

  // --- Retiro ---
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

// ======== Handler de Foto (comprobante) ========
bot.on('photo', async (ctx) => {
  const uid = ctx.from.id;
  const photos = ctx.message.photo || [];
  if (!photos.length) return;
  const best = photos[photos.length - 1];
  const fileId = best.file_id;

  const { data: dep } = await supabase.from('depositos')
    .select('id, estado')
    .eq('telegram_id', uid).eq('estado', 'pendiente')
    .order('id', { ascending: false }).limit(1).maybeSingle();

  if (!dep) return ctx.reply('No encuentro depósito pendiente.');

  await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
  await ctx.reply(`Comprobante guardado (#${dep.id}).`);

  await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
    caption: `🧾 DEPÓSITO\nID: ${dep.id}\nUser: ${uid}`,
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Aprobar', callback_data: `dep:approve:${dep.id}` }],
      [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}` }]
    ]}
  });
});

// ======== Aprobar/Rechazar Depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  const depId = Number(ctx.match[1]);
  const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
  if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

  const car = await carteraDe(d.telegram_id);
  const nuevoPrincipal = car.principal + d.monto;
  const nuevoSaldo     = car.saldo + d.monto;
  const nuevoBruto     = nuevoPrincipal / 0.9;

  await actualizarCartera(d.telegram_id, { principal: nuevoPrincipal, saldo: nuevoSaldo, bruto: nuevoBruto });
  await supabase.from('depositos').update({ estado: 'aprobado' }).eq('id', depId);

  await bot.telegram.sendMessage(d.telegram_id, `✅ Depósito aprobado: ${d.monto.toFixed(2)} USDT\nNuevo saldo: ${nuevoSaldo.toFixed(2)}`);
  await ctx.editMessageReplyMarkup();
  await ctx.reply(`Depósito #${depId} aprobado.`);
});

bot.action(/dep:reject:(\d+)/, async (ctx) => {
  const depId = Number(ctx.match[1]);
  await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
  await ctx.editMessageReplyMarkup();
  await ctx.reply(`Depósito #${depId} rechazado.`);
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

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  const rid = Number(ctx.match[1]);
  await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);
  await ctx.editMessageReplyMarkup();
  await ctx.reply(`Retiro #${rid} rechazado.`);
});

// ======== Webhook / Ping ========
app.get('/', (_, res) => res.send('OK'));
app.post('/webhook', (req, res) => res.sendStatus(200));

app.listen(PORT, async () => {
  console.log(`HTTP on :${PORT}`);
  bot.launch();
  console.log('Bot lanzado.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
