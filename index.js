// ================== FortunaMoney Bot (webhook + pagos manuales) ==================
require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ======== ENV ========
const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_KEY,
  ADMIN_ID,
  ADMIN_GROUP_ID,
  HOST_URL,
  WEBHOOK_SECRET,
  CUP_USDT_RATE = 400,
  MIN_INVERSION = 25,
  RETIRO_FEE_USDT = 1,
  WALLET_USDT = 'WALLET_NO_CONFIGURADA',
  WALLET_CUP  = 'TARJETA_NO_CONFIGURADA',
  PORT = 3000
} = process.env;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID || !HOST_URL || !WEBHOOK_SECRET) {
  console.error('Faltan variables de entorno obligatorias.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Helpers ========
const numero = (x) => Number(x || 0);
const kb = () => Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();

async function asegurarUsuario(uid) {
  await supabase.from('usuarios').upsert([{ telegram_id: uid }], { onConflict: 'telegram_id' });
  // crea cartera si no existe y asegura columnas nuevas
  await supabase.from('carteras').upsert([{
    telegram_id: uid, saldo: 0, principal: 0, bruto: 0, ganado: 0, bonos: 0
  }], { onConflict: 'telegram_id' });
}

async function carteraDe(uid) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, bruto, ganado, bonos')
    .eq('telegram_id', uid)
    .maybeSingle();
  return {
    saldo:   numero(data?.saldo),
    principal: numero(data?.principal),
    bruto:   numero(data?.bruto),
    ganado:  numero(data?.ganado),
    bonos:   numero(data?.bonos),
  };
}

async function actualizarCartera(uid, patch) {
  const cur = await carteraDe(uid);
  const row = {
    telegram_id: uid,
    saldo:     patch.saldo     !== undefined ? patch.saldo     : cur.saldo,
    principal: patch.principal !== undefined ? patch.principal : cur.principal,
    bruto:     patch.bruto     !== undefined ? patch.bruto     : cur.bruto,
    ganado:    patch.ganado    !== undefined ? patch.ganado    : cur.ganado,
    bonos:     patch.bonos     !== undefined ? patch.bonos     : cur.bonos,
    // para compatibilidad antigua:
    invertido: patch.principal !== undefined ? patch.principal : cur.principal
  };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

function textoSaldo({ principal, saldo, bruto, ganado, bonos }) {
  const top = bruto * 5;
  const progreso = top > 0 ? ((ganado + bonos) / top) * 100 : 0;
  return (
    'Tu saldo (en USDT):\n\n' +
    `Principal (invertido):  ${principal.toFixed(2)}\n` +
    `Disponible:             ${saldo.toFixed(2)}\n` +
    `Total:                  ${(principal + saldo).toFixed(2)}\n\n` +
    `Base para 500% (BRUTO): ${bruto.toFixed(2)}\n` +
    `Tope 500%:              ${top.toFixed(2)}\n` +
    `Ganado (acumulado):     ${ganado.toFixed(2)}\n` +
    `Bonos referidos:        ${bonos.toFixed(2)}\n` +
    `Progreso hacia 500%:    ${progreso.toFixed(2)}%`
  );
}

// ======== Captura referidos en /start ref_XXXX ========
bot.start(async (ctx) => {
  const uid = ctx.from.id;
  await asegurarUsuario(uid);

  // start payload
  const startPayload = ctx.startPayload || (ctx.message?.text?.split(' ').slice(1).join(' ') || '');
  const m = startPayload.match(/^ref_(\d+)$/i);
  if (m) {
    const sponsor = Number(m[1]);
    if (sponsor && sponsor !== uid) {
      try {
        // solo setear si está vacío
        const { data: u } = await supabase.from('usuarios')
          .select('referido_por').eq('telegram_id', uid).single();
        if (!u?.referido_por) {
          await supabase.from('usuarios').update({ referido_por: sponsor }).eq('telegram_id', uid);
          try { await bot.telegram.sendMessage(sponsor, `🎉 Nuevo referido: ${uid}`); } catch {}
        }
      } catch {}
    }
  }

  await ctx.reply('¡Bienvenido a FortunaMoney!', kb());
});

// ======== Menú simple ========
bot.hears('Saldo', async (ctx) => {
  try {
    const uid = ctx.from.id;
    await asegurarUsuario(uid);
    const car = await carteraDe(uid);
    await ctx.reply(textoSaldo(car), kb());
  } catch (e) { console.log('Saldo error:', e); }
});

bot.hears('Referidos', async (ctx) => {
  const uid = ctx.from.id;
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
  await ctx.reply(`Tu enlace de referido:\n${link}`);
});

// ======== Invertir ========
bot.hears('Invertir', async (ctx) => {
  await ctx.reply('Elige método de inversión:', Markup.inlineKeyboard([
    [{ text: 'USDT (BEP20)', callback_data: 'inv:usdt' }],
    [{ text: 'CUP (Tarjeta)', callback_data: 'inv:cup' }],
  ]));
});

const estado = {}; // 'INV_USDT' | 'INV_CUP' | 'RET'

bot.action('inv:usdt', async (ctx) => { estado[ctx.from.id] = 'INV_USDT'; await ctx.answerCbQuery(); await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}).`); });
bot.action('inv:cup',  async (ctx) => { estado[ctx.from.id] = 'INV_CUP';  await ctx.answerCbQuery(); await ctx.reply('Escribe el monto a invertir en CUP (mínimo 500).'); });

// ======== Retirar ========
bot.hears('Retirar', async (ctx) => {
  const uid = ctx.from.id;
  const car = await carteraDe(uid);
  estado[uid] = 'RET';
  await ctx.reply(
    `Tu saldo disponible es: ${car.saldo.toFixed(2)} USDT\n` +
    `Fee de retiro: ${Number(RETIRO_FEE_USDT).toFixed(2)} USDT\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de montos (texto) ========
bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const st = estado[uid];
  const raw = (ctx.message.text || '').trim();
  if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;
  if (raw.startsWith('/')) return;

  const monto = Number(String(raw).replace(',', '.'));
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');
  await asegurarUsuario(uid);

  // --- Inversión ---
  if (st === 'INV_USDT' || st === 'INV_CUP') {
    if (st === 'INV_USDT' && monto < Number(MIN_INVERSION)) return ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
    if (st === 'INV_CUP'  && monto < 500) return ctx.reply('El mínimo de inversión es 500 CUP.');

    const moneda = st === 'INV_USDT' ? 'USDT' : 'CUP';
    const tasa_usdt = st === 'INV_CUP' ? Number(CUP_USDT_RATE) : null;
    const monto_usdt = st === 'INV_CUP' ? (monto / tasa_usdt) : monto;

    const ins = await supabase.from('depositos').insert([{
      telegram_id: uid,
      monto: monto_usdt,         // USDT equivalentes (base para principal/bruto)
      moneda,
      monto_origen: monto,       // lo que escribió
      tasa_usdt,
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) return ctx.reply('No pude crear el depósito. Intenta de nuevo.');

    const depId = ins.data.id;
    const instrucciones = (moneda === 'USDT')
      ? `Método: USDT (BEP20)\nWallet: ${WALLET_USDT}`
      : `Método: CUP (Tarjeta)\nNúmero de tarjeta: ${WALLET_CUP}`;

    await ctx.reply(
      `✅ Depósito creado (pendiente).\n\n` +
      `ID: ${depId}\n` +
      `Monto: ${monto.toFixed(2)} ${moneda}\n` +
      (moneda === 'CUP' ? `Equivalente: ${monto_usdt.toFixed(2)} USDT\n` : '') +
      `${instrucciones}\n\n` +
      `• Envía hash (USDT) o foto del pago (CUP).\n` +
      `• Cuando el admin confirme, se acreditará tu inversión.`,
      kb()
    );

    // aviso admin
    try {
      await bot.telegram.sendMessage(
        Number(ADMIN_GROUP_ID),
        `📥 DEPÓSITO pendiente\nID: #${depId}\nUser: ${uid}\n` +
        `Monto: ${monto.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Eq: ${monto_usdt.toFixed(2)} USDT\n` : ''),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
              [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}` }]
            ]
          }
        }
      );
    } catch {}
    estado[uid] = undefined;
    return;
  }

  // --- Retiro ---
  if (st === 'RET') {
    const car = await carteraDe(uid);
    const total = monto + Number(RETIRO_FEE_USDT);
    if (total > car.saldo) return ctx.reply('Saldo insuficiente.');
    const ins = await supabase.from('retiros').insert([{
      telegram_id: uid, monto, estado: 'pendiente'
    }]).select('id').single();
    if (ins.error) return ctx.reply('No pude crear el retiro.');

    const retId = ins.data.id;
    await ctx.reply(`✅ Retiro creado (pendiente)\nID: ${retId}\nMonto: ${monto.toFixed(2)} USDT\nFee: ${Number(RETIRO_FEE_USDT).toFixed(2)} USDT`, kb());
    try {
      await bot.telegram.sendMessage(
        Number(ADMIN_GROUP_ID),
        `🆕 RETIRO pendiente\nID: #${retId}\nUser: ${uid}\nMonto: ${monto.toFixed(2)} USDT`,
        { reply_markup: { inline_keyboard: [
          [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
          [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}` }]
        ]}}
      );
    } catch {}
    estado[uid] = undefined;
    return;
  }
});

// ======== Comprobante en foto ========
bot.on('photo', async (ctx) => {
  const uid = ctx.from.id;
  const photos = ctx.message.photo || [];
  if (!photos.length) return;
  const fileId = photos[photos.length - 1].file_id;

  const { data: dep } = await supabase.from('depositos')
    .select('id, estado').eq('telegram_id', uid).eq('estado', 'pendiente')
    .order('id', { ascending: false }).limit(1).maybeSingle();

  if (!dep) return ctx.reply('No encuentro depósito pendiente.');
  await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
  await ctx.reply(`Comprobante guardado (#${dep.id}).`);

  try {
    await bot.telegram.sendPhoto(Number(ADMIN_GROUP_ID), fileId, {
      caption: `🧾 DEPÓSITO\nID: ${dep.id}\nUser: ${uid}`,
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Aprobar',  callback_data: `dep:approve:${dep.id}` }],
        [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}` }]
      ]}
    });
  } catch {}
});

// ======== Aprobaciones ADMIN ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id != Number(ADMIN_ID) && ctx.chat?.id != Number(ADMIN_GROUP_ID)) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // 1) actualizar cartera del usuario: principal += 90% de d.monto, bruto += 100% d.monto (no tocar saldo)
    const car = await carteraDe(d.telegram_id);
    const neto = numero(d.monto) * 0.9;
    await actualizarCartera(d.telegram_id, {
      principal: car.principal + neto,
      bruto: car.bruto + numero(d.monto)
    });

    // 2) pagar bono de referido 10% al sponsor (si existe)
    try {
      const { data: u } = await supabase.from('usuarios')
        .select('referido_por').eq('telegram_id', d.telegram_id).single();

      if (u?.referido_por) {
        // anti-doble pago si existe columna
        let yaPagado = false;
        try {
          const { data: d2 } = await supabase.from('depositos')
            .select('ref_pagado').eq('id', depId).single();
          yaPagado = d2?.ref_pagado === true;
        } catch {}

        if (!yaPagado) {
          const sponsor = Number(u.referido_por);
          const carS = await carteraDe(sponsor);
          const bono = numero(d.monto) * 0.10;

          await actualizarCartera(sponsor, {
            saldo:  carS.saldo + bono,
            bonos:  carS.bonos + bono
          });

          try { await bot.telegram.sendMessage(sponsor, `🎁 Bono de referido: +${bono.toFixed(2)} USDT`); } catch {}

          // marcar pagado si la columna existe
          try { await supabase.from('depositos').update({ ref_pagado: true }).eq('id', depId); } catch {}
        }
      }
    } catch (e2) { console.log('ref error:', e2?.message || e2); }

    // 3) marcar depósito aprobado
    await supabase.from('depositos').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', depId);

    // 4) avisos
    try {
      await bot.telegram.sendMessage(
        d.telegram_id,
        `✅ Depósito aprobado: ${numero(d.monto).toFixed(2)} USDT\n` +
        `A tu principal se acreditó: ${(numero(d.monto)*0.9).toFixed(2)} USDT\n` +
        `BRUTO base actualizado: ${numero(d.monto).toFixed(2)} USDT`
      );
    } catch {}
    try { await ctx.editMessageReplyMarkup(); } catch {}
    await ctx.reply(`Depósito #${depId} aprobado.`);
  } catch (e) { console.log('dep approve err', e); }
});

bot.action(/dep:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id != Number(ADMIN_ID) && ctx.chat?.id != Number(ADMIN_GROUP_ID)) return;
    const depId = Number(ctx.match[1]);
    await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
    try { await ctx.editMessageReplyMarkup(); } catch {}
    await ctx.reply(`Depósito #${depId} rechazado.`);
  } catch {}
});

bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id != Number(ADMIN_ID) && ctx.chat?.id != Number(ADMIN_GROUP_ID)) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r || r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const car = await carteraDe(r.telegram_id);
    const total = numero(r.monto) + Number(RETIRO_FEE_USDT);
    if (total > car.saldo) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: car.saldo - total });
    await supabase.from('retiros').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT`); } catch {}
    try { await ctx.editMessageReplyMarkup(); } catch {}
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log('ret approve err', e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id != Number(ADMIN_ID) && ctx.chat?.id != Number(ADMIN_GROUP_ID)) return;
    const rid = Number(ctx.match[1]);
    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);
    try { await ctx.editMessageReplyMarkup(); } catch {}
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch {}
});

// ======== Pagar hoy (manual, tantas veces como quieras) ========
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id != Number(ADMIN_ID)) return ctx.reply('Solo admin.');
  await ctx.reply('⏳ Procesando pagos del día...');

  const { data: lista, error } = await supabase
    .from('carteras')
    .select('telegram_id, principal, saldo, ganado')
    .gt('principal', 0);

  if (error) return ctx.reply('Error leyendo carteras.');

  let totalUsuarios = 0, totalPagado = 0;

  for (const c of (lista || [])) {
    const principal = numero(c.principal);
    const tasa = principal > 500 ? 0.02 : 0.015;
    const pago = principal * tasa;
    if (pago <= 0) continue;

    totalUsuarios++;
    totalPagado += pago;

    await actualizarCartera(c.telegram_id, {
      saldo:  numero(c.saldo)  + pago,
      ganado: numero(c.ganado) + pago
    });

    try {
      await bot.telegram.sendMessage(
        c.telegram_id,
        `💰 Pago diario: +${pago.toFixed(2)} USDT (${(tasa*100).toFixed(2)}%)`
      );
    } catch {}
  }

  await ctx.reply(`✅ Pagos listos.\nUsuarios: ${totalUsuarios}\nTotal abonado: ${totalPagado.toFixed(2)} USDT`);
});

// ======== Webhook (Render) ========
const app = express();
app.use(express.json());

// Usamos un secreto en la ruta, no el token
const webhookPath = `/webhook/${WEBHOOK_SECRET}`;
app.use(bot.webhookCallback(webhookPath));

// Asegurar el webhook en Telegram al iniciar
(async () => {
  try {
    const url = `${HOST_URL}${webhookPath}`;
    await bot.telegram.setWebhook(url);
    console.log('Webhook configurado en:', url);
  } catch (e) {
    console.error('No pude configurar el webhook:', e);
    process.exit(1);
  }
})();

app.get('/', (_req, res) => res.send('OK FortunaMoney ✅'));
app.listen(Number(PORT), () => {
  console.log(`HTTP server on port ${PORT}`);
});
