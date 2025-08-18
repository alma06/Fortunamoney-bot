// ================== FortunaMoney Bot (webhook) ==================
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ======== ENV ========
const BOT_TOKEN        = process.env.BOT_TOKEN;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const ADMIN_ID         = Number(process.env.ADMIN_ID || 0);
const ADMIN_GROUP_ID   = Number(process.env.ADMIN_GROUP_ID || 0);
const WALLET_USDT      = process.env.WALLET_USDT || 'WALLET_NO_CONFIGURADA';
const WALLET_CUP       = process.env.WALLET_CUP  || 'TARJETA_NO_CONFIGURADA';
const HOST_URL         = process.env.HOST_URL || ''; // https://xxx.onrender.com
const PORT             = Number(process.env.PORT || 3000);
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET || 'hooksecret';

// Reglas
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25); // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE  || 400); // 1 USDT = 400 CUP

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID || !HOST_URL) {
  console.log('Faltan variables de entorno obligatorias.');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Helpers ========
const numero = (x) => Number(x || 0);
const menu = () => Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();

// NO sobrescribe si ya existe
async function asegurarUsuario(telegram_id) {
  // usuarios
  const u = await supabase.from('usuarios').select('telegram_id').eq('telegram_id', telegram_id).maybeSingle();
  if (!u.data) {
    await supabase.from('usuarios').insert([{ telegram_id }]);
  }

  // carteras
  const c = await supabase.from('carteras').select('telegram_id').eq('telegram_id', telegram_id).maybeSingle();
  if (!c.data) {
    await supabase.from('carteras').insert([{ telegram_id, saldo: 0, principal: 0, bruto: 0, bono: 0 }]);
  }
}

async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, bruto, bono')
    .eq('telegram_id', telegram_id)
    .maybeSingle();
  return {
    saldo: numero(data?.saldo),
    principal: numero(data?.principal),
    bruto: numero(data?.bruto),
    bono: numero(data?.bono)
  };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);
  const row = {
    telegram_id,
    saldo:     (patch.saldo     !== undefined) ? numero(patch.saldo)     : cur.saldo,
    principal: (patch.principal !== undefined) ? numero(patch.principal) : cur.principal,
    bruto:     (patch.bruto     !== undefined) ? numero(patch.bruto)     : cur.bruto,
    bono:      (patch.bono      !== undefined) ? numero(patch.bono)      : cur.bono,
  };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

function top500(bruto) { return numero(bruto) * 5; }
function progreso500({saldo, principal, bono, bruto}) {
  const top = top500(bruto);
  if (top <= 0) return 0;
  return ((saldo + principal + bono) / top) * 100;
}

// ======== REFERIDOS (/start ref_123) ========
bot.start(async (ctx) => {
  const me = ctx.from.id;
  await asegurarUsuario(me);

  // payload de invitación
  const payload = (ctx.startPayload || '').trim();
  if (payload.startsWith('ref_')) {
    const sponsorId = Number(payload.replace('ref_', '').trim());
    if (sponsorId && sponsorId !== me) {
      // set patrocinador si aún no existe
      const { data: u } = await supabase.from('usuarios').select('patrocinador_id').eq('telegram_id', me).maybeSingle();
      if (!u?.patrocinador_id) {
        await supabase.from('usuarios').update({ patrocinador_id: sponsorId }).eq('telegram_id', me);
      }
    }
  }

  await ctx.reply('¡Bienvenido a FortunaMoney!', menu());
});

// ======== Saldo ========
bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const car = await carteraDe(chatId);
    const total = car.saldo + car.principal + car.bono;
    const top = top500(car.bruto);
    const prog = progreso500(car);

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${car.principal.toFixed(2)}\n` +
      `Disponible:             ${car.saldo.toFixed(2)}\n` +
      `Bonos referidos:        ${car.bono.toFixed(2)}\n` +
      `Total:                  ${total.toFixed(2)}\n\n` +
      `Bruto (base 500%):      ${car.bruto.toFixed(2)}\n` +
      `Tope 500%:              ${top.toFixed(2)}\n` +
      `Progreso al 500%:       ${prog.toFixed(2)}%`,
      menu()
    );
  } catch (e) {
    console.log('ERROR Saldo:', e);
    try { await ctx.reply('Error obteniendo tu saldo.'); } catch {}
  }
});

// ======== Referidos (enlace) ========
bot.hears('Referidos', async (ctx) => {
  const uid = ctx.from.id;
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
  await ctx.reply(`Tu enlace de referido:\n${link}`, menu());
});

// ======== Invertir ========
const estado = {}; // 'INV_USDT' | 'INV_CUP' | 'RET'

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

// ======== Handler de Texto (monto) ========
bot.on('text', async (ctx) => {
  const chatId = ctx.from.id;
  const st = estado[chatId];
  const txt = (ctx.message.text || '').trim().replace(',', '.');
  if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;
  const monto = Number(txt);
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

  // --- Inversión ---
  if (st === 'INV_USDT' || st === 'INV_CUP') {
    if (st === 'INV_USDT' && monto < MIN_INVERSION) return ctx.reply(`Mínimo: ${MIN_INVERSION} USDT.`);
    if (st === 'INV_CUP' && monto < 500) return ctx.reply('Mínimo: 500 CUP.');

    await asegurarUsuario(chatId);

    let moneda = st === 'INV_USDT' ? 'USDT' : 'CUP';
    let montoFinal = monto;
    let tasa_usdt = null;
    if (st === 'INV_CUP') {
      tasa_usdt = CUP_USDT_RATE;
      montoFinal = monto / tasa_usdt;
    }

    const ins = await supabase.from('depositos').insert([{
      telegram_id: chatId,
      monto: montoFinal,          // USDT
      moneda,
      monto_origen: monto,
      tasa_usdt,
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) return ctx.reply('Error guardando depósito.');

    const depId = ins.data.id;
    const instrucciones = (moneda === 'USDT')
      ? `Método: USDT (BEP20)\nWallet: ${WALLET_USDT}`
      : `Método: CUP (Tarjeta)\nTarjeta: ${WALLET_CUP}`;

    await ctx.reply(
      `✅ Depósito creado (pendiente).\n` +
      `ID: ${depId}\n` +
      `Monto: ${monto.toFixed(2)} ${moneda}\n` +
      (moneda === 'CUP' ? `Equivalente: ${montoFinal.toFixed(2)} USDT\n` : '') +
      `${instrucciones}\n\n` +
      `• Envía hash (USDT) con /tx <id> <hash> o una foto del pago (CUP).`,
      menu()
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
      telegram_id: chatId, monto, estado: 'pendiente'
    }]).select('id').single();
    if (ins.error) return ctx.reply('Error creando retiro.');
    const retId = ins.data.id;

    await ctx.reply(`✅ Retiro creado (pendiente). ID: ${retId}\nMonto: ${monto.toFixed(2)} USDT\nFee: ${RETIRO_FEE_USDT.toFixed(2)} USDT`);

    await bot.telegram.sendMessage(ADMIN_GROUP_ID,
      `🆕 RETIRO pendiente\nID: #${retId}\nUser: ${chatId}\nMonto: ${monto.toFixed(2)} USDT`, {
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
  try {
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
  } catch (e) {
    console.error('Error en handler de foto:', e);
  }
});

// ======== /tx id hash ========
bot.command('tx', async (ctx) => {
  try {
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    if (parts.length < 3) return ctx.reply('Uso: /tx <id_deposito> <hash>');
    const depId = Number(parts[1]);
    const hash = parts.slice(2).join(' ');

    const { data: dep } = await supabase.from('depositos')
      .select('id, telegram_id, estado')
      .eq('id', depId).maybeSingle();

    if (!dep || dep.telegram_id !== ctx.from.id) return ctx.reply('Depósito no encontrado.');
    if (dep.estado !== 'pendiente') return ctx.reply('Ese depósito ya no está pendiente.');

    await supabase.from('depositos').update({ tx: hash }).eq('id', depId);

    await bot.telegram.sendMessage(ADMIN_GROUP_ID,
      `🔗 Hash recibido\nDepósito: #${depId}\nUser: ${ctx.from.id}\nHash: ${hash}`, {
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
          [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}` }]
        ] }
      });

    await ctx.reply('Hash agregado al depósito.');
  } catch (e) { console.log(e); }
});

// ======== Aprobar/Rechazar Depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Acreditar inversión: 90% a principal, 100% a bruto
    const neto = numero(d.monto) * 0.90;

    const carPrev = await carteraDe(d.telegram_id);
    const nuevoPrincipal = carPrev.principal + neto;
    const nuevoBruto = carPrev.bruto + numero(d.monto);

    await actualizarCartera(d.telegram_id, { principal: nuevoPrincipal, bruto: nuevoBruto });

    // Marcar depósito
    await supabase.from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    // Pagar bono 10% al patrocinador (al saldo, retirable)
    try {
      const { data: u } = await supabase.from('usuarios')
        .select('patrocinador_id').eq('telegram_id', d.telegram_id).maybeSingle();
      const sponsor = u?.patrocinador_id ? Number(u.patrocinador_id) : null;

      if (sponsor) {
        const bono = numero(d.monto) * 0.10;
        const carS = await carteraDe(sponsor);
        await actualizarCartera(sponsor, { saldo: carS.saldo + bono, bono: carS.bono + bono });

        // Notifica al sponsor
        try {
          await bot.telegram.sendMessage(sponsor,
            `🎉 Bono de referido acreditado: ${bono.toFixed(2)} USDT\n` +
            `Por el depósito de tu referido ${d.telegram_id}.`);
        } catch {}
      }
    } catch (e) { console.log('BONO ref error:', e); }

    // Aviso al usuario
    try {
      await bot.telegram.sendMessage(
        d.telegram_id,
        `✅ Depósito aprobado: ${numero(d.monto).toFixed(2)} USDT.\n` +
        `A tu principal se acreditó: ${neto.toFixed(2)} USDT.\n` +
        `Bruto (base 500%): ${nuevoBruto.toFixed(2)} USDT.`
      );
    } catch (eMsg) { console.log('No se pudo avisar al usuario:', eMsg?.message || eMsg); }

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} aprobado.`);
  } catch (e) { console.log(e); }
});

bot.action(/dep:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);
    await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} rechazado.`);
  } catch (e) { console.log(e); }
});

// ======== Aprobar/Rechazar Retiro ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r || r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const car = await carteraDe(r.telegram_id);
    const totalDebitar = numero(r.monto) + RETIRO_FEE_USDT;
    if (totalDebitar > car.saldo) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: car.saldo - totalDebitar });
    await supabase.from('retiros').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', rid);

    await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT`);
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log(e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch (e) { console.log(e); }
});

// ======== /pagarhoy (solo ADMIN) ========
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const { data: lista } = await supabase.from('carteras').select('telegram_id, saldo, principal, bruto, bono');
    if (!lista || !lista.length) return ctx.reply('No hay carteras.');

    let totalPagado = 0, usuariosPagados = 0;
    for (const c of lista) {
      const principal = numero(c.principal);
      const bruto = numero(c.bruto);
      if (principal <= 0 || bruto <= 0) continue;

      const rate = principal < 500 ? 0.015 : 0.02;
      let pago = principal * rate;

      // respetar tope 500%
      const top = top500(bruto);
      const valorActual = numero(c.saldo) + principal + numero(c.bono);
      const margen = top - valorActual;
      if (margen <= 0) continue;
      if (pago > margen) pago = margen;

      if (pago > 0) {
        await actualizarCartera(c.telegram_id, { saldo: numero(c.saldo) + pago });
        totalPagado += pago; usuariosPagados += 1;

        // aviso opcional al usuario
        try {
          await bot.telegram.sendMessage(
            c.telegram_id,
            `💸 Ganancia acreditada hoy: ${pago.toFixed(2)} USDT\n` +
            `Tasa aplicada: ${(rate*100).toFixed(2)}%`
          );
        } catch {}
      }
    }
    await ctx.reply(`Pago manual realizado.\nUsuarios acreditados: ${usuariosPagados}\nTotal pagado: ${totalPagado.toFixed(2)} USDT`);
  } catch (e) {
    console.log('ERROR pagarhoy:', e);
    try { await ctx.reply('Error en /pagarhoy'); } catch {}
  }
});

// ================== Webhook ==================
app.get('/', (_req, res) => res.send('OK'));

app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  try {
    bot.handleUpdate(req.body);
  } catch (e) {
    console.log('handleUpdate error:', e);
  }
  res.sendStatus(200);
});

(async () => {
  // Configura webhook
  await bot.telegram.setWebhook(`${HOST_URL}/webhook/${WEBHOOK_SECRET}`);
  // Lanza HTTP
  app.listen(PORT, () => {
    console.log(`HTTP on :${PORT}`);
    console.log(`Webhook configurado en: ${HOST_URL}/webhook/${WEBHOOK_SECRET}`);
    console.log('Your service is live 🎉');
  });
})();
