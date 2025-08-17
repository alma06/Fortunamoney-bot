// ================== FortunaMoney Bot (webhook + referidos + pagarhoy) ==================
require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ======== ENV ========
const BOT_TOKEN      = process.env.BOT_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ADMIN_ID       = Number(process.env.ADMIN_ID || 0);
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID || 0);
const HOST_URL       = process.env.HOST_URL || '';  // p.ej: https://tu-servicio.onrender.com
const PORT           = Number(process.env.PORT || 3000);

// Reglas
const MIN_INVERSION    = Number(process.env.MIN_INVERSION   || 25);   // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE   || 400);  // 1 USDT = 400 CUP

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID || !HOST_URL) {
  console.log('Faltan variables de entorno obligatorias.');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado en memoria (para wizard monto) ========
const estado = {}; // valores: 'INV_USDT' | 'INV_CUP' | 'RET'

// ======== Helpers ========
function numero(x) { return Number(x || 0); }

function menu() {
  return Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
}

// Crea usuario (y guarda ref_by si viene en /start) y su cartera si no existe
async function asegurarUsuario(telegram_id, ref_by = null) {
  // No sobreescribir ref_by si ya existe
  let insert = { telegram_id };
  if (ref_by) {
    const { data: uex } = await supabase.from('usuarios')
      .select('telegram_id, ref_by')
      .eq('telegram_id', telegram_id)
      .maybeSingle();
    if (!uex || !uex.ref_by) insert.ref_by = ref_by;
  }

  await supabase.from('usuarios').upsert([insert], { onConflict: 'telegram_id' });
  await supabase.from('carteras').upsert([{ telegram_id, saldo: 0, principal: 0, bruto: 0 }], { onConflict: 'telegram_id' });
}

// Lee cartera tolerando “principal” o “invertido”
async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, invertido, bruto')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  const saldo = numero(data?.saldo);
  const principal = (data && data.principal !== undefined) ? numero(data.principal) : numero(data?.invertido);
  const bruto = numero(data?.bruto);

  return { saldo, principal, bruto };
}

// Escribe en ambas columnas para cubrir ambos esquemas
async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);

  const nuevoSaldo     = (patch.saldo     !== undefined) ? numero(patch.saldo)     : cur.saldo;
  const nuevoPrincipal = (patch.principal !== undefined) ? numero(patch.principal) : cur.principal;
  const nuevoBruto     = (patch.bruto     !== undefined) ? numero(patch.bruto)     : cur.bruto;

  const row = {
    telegram_id,
    saldo: nuevoSaldo,
    principal: nuevoPrincipal,
    invertido: nuevoPrincipal, // espejo por compatibilidad
    bruto: nuevoBruto
  };

  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== UI ========

// /start con posible payload ref_xxxxx
bot.start(async (ctx) => {
  try {
    const me = ctx.from.id;
    let ref_by = null;

    // Telegraf expone payload en ctx.startPayload
    const payload = (ctx.startPayload || '').trim();
    if (payload.startsWith('ref_')) {
      const maybeId = Number(payload.replace('ref_', '').trim());
      if (maybeId && maybeId !== me) ref_by = maybeId;
    }

    await asegurarUsuario(me, ref_by);
    await ctx.reply('¡Bienvenido a FortunaMoney!', menu());
  } catch (e) {
    console.log('ERROR start:', e);
    try { await ctx.reply('Ocurrió un error.'); } catch {}
  }
});

// Referidos → link personal
bot.hears('Referidos', async (ctx) => {
  const me = ctx.from.id;
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${me}`;
  await ctx.reply(`Tu enlace de referido:\n${link}`);
});

// Saldo
bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const { saldo, principal, bruto } = await carteraDe(chatId);
    const total = numero(saldo) + numero(principal);
    const tope500 = numero(bruto) * 5;  // meta final
    const progreso = bruto ? (total / bruto * 100) : 0;

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${principal.toFixed(2)}\n` +
      `Disponible:             ${saldo.toFixed(2)}\n` +
      `Total:                  ${total.toFixed(2)}\n\n` +
      `Base para 500% (BRUTO): ${bruto.toFixed(2)}\n` +
      `Tope 500%:              ${tope500.toFixed(2)}\n` +
      `Progreso hacia 500%:    ${progreso.toFixed(2)}%`,
      menu()
    );
  } catch (e) {
    console.log('ERROR Saldo:', e);
    try { await ctx.reply('Error obteniendo tu saldo. Intenta de nuevo.'); } catch {}
  }
});

// Invertir
bot.hears('Invertir', async (ctx) => {
  await ctx.reply('Elige método de inversión:', Markup.inlineKeyboard([
    [{ text: 'USDT (BEP20)', callback_data: 'inv:usdt' }],
    [{ text: 'CUP (Tarjeta)', callback_data: 'inv:cup' }],
  ]));
});

bot.action('inv:usdt', async (ctx) => {
  const chatId = ctx.from.id;
  estado[chatId] = 'INV_USDT';
  await ctx.answerCbQuery();
  await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}). Solo número, ej: 50.00`);
});

bot.action('inv:cup', async (ctx) => {
  const chatId = ctx.from.id;
  estado[chatId] = 'INV_CUP';
  await ctx.answerCbQuery();
  await ctx.reply('Escribe el monto a invertir en CUP (mínimo 500). Solo número, ej: 20000');
});

// Retirar
bot.hears('Retirar', async (ctx) => {
  const chatId = ctx.from.id;
  const car = await carteraDe(chatId);
  estado[chatId] = 'RET';
  await ctx.reply(
    `Tu saldo disponible es: ${numero(car.saldo).toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT (se descuenta además del monto solicitado).\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de Texto (monto) ========
bot.on('text', async (ctx) => {
  const chatId = ctx.from.id;
  const st = estado[chatId];
  const txtRaw = (ctx.message?.text ?? '').trim();
  if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;
  const monto = Number(txtRaw.replace(',', '.'));
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

  // --- Inversión ---
  if (st === 'INV_USDT' || st === 'INV_CUP') {
    if (st === 'INV_USDT' && monto < MIN_INVERSION) {
      return ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
    }
    if (st === 'INV_CUP' && monto < 500) {
      return ctx.reply('El mínimo de inversión es 500 CUP.');
    }

    await asegurarUsuario(chatId);

    const moneda = (st === 'INV_USDT') ? 'USDT' : 'CUP';
    const tasa_usdt = (st === 'INV_CUP') ? CUP_USDT_RATE : null;
    const monto_origen = monto;
    const monto_usdt = (st === 'INV_CUP') ? (monto / CUP_USDT_RATE) : monto;

    const ins = await supabase.from('depositos').insert([{
      telegram_id: chatId,
      monto: monto_usdt,     // USDT equivalentes
      moneda,
      monto_origen,
      tasa_usdt,
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) return ctx.reply('Error guardando depósito. Intenta nuevamente.');

    const depId = ins.data.id;
    await ctx.reply(
      '✅ Depósito creado (pendiente).\n\n' +
      `ID: ${depId}\n` +
      `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
      (moneda === 'CUP' ? `Equivalente: ${monto_usdt.toFixed(2)} USDT\n` : '') +
      '• Envía el hash (USDT) o una foto del pago (CUP).\n' +
      '• Cuando el admin confirme, tu inversión será acreditada.',
      menu()
    );

    // Aviso admin con botones
    try {
      const adminBody =
        `📥 DEPÓSITO pendiente\n` +
        `ID: #${depId}\n` +
        `User: ${chatId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${monto_usdt.toFixed(2)} USDT\n` : ``) +
        `Usa los botones para validar.`;

      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        adminBody,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
              [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
            ]
          }
        }
      );
    } catch (e2) { console.log('Aviso admin dep:', e2?.message || e2); }

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

    if (ins.error) return ctx.reply('No se pudo crear el retiro. Intenta nuevamente.');
    const retId = ins.data.id;

    await ctx.reply(
      `✅ Retiro creado (pendiente).\n\n` +
      `ID: ${retId}\n` +
      `Monto: ${monto.toFixed(2)} USDT\n` +
      `Fee descontado: ${RETIRO_FEE_USDT.toFixed(2)} USDT`,
      menu()
    );

    // Aviso admin
    try {
      const body =
        `🆕 RETIRO pendiente\n` +
        `ID: #${retId}\n` +
        `User: ${chatId}\n` +
        `Monto: ${monto.toFixed(2)} USDT`;
      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        body,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
              [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}`  }]
            ]
          }
        }
      );
    } catch (e3) { console.log('Aviso admin ret:', e3?.message || e3); }

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

    // Último depósito pendiente del usuario
    const { data: dep } = await supabase.from('depositos')
      .select('id, estado')
      .eq('telegram_id', uid).eq('estado', 'pendiente')
      .order('id', { ascending: false }).limit(1).maybeSingle();

    if (!dep) {
      await ctx.reply('No encuentro un depósito pendiente para guardar tu comprobante.');
      return;
    }

    await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
    await ctx.reply(`Comprobante guardado (#${dep.id}).`);

    // Enviar al grupo admin
    try {
      const caption =
        "🧾 Comprobante de DEPÓSITO\n" +
        `ID: ${dep.id}\n` +
        `Usuario: ${uid}\n`;
      await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Aprobar",  callback_data: `dep:approve:${dep.id}` }],
            [{ text: "❌ Rechazar", callback_data: `dep:reject:${dep.id}` }]
          ]
        }
      });
    } catch (err) { console.error("Error enviando comprobante al grupo:", err); }
  } catch (e) { console.error("Error en handler de foto:", e); }
});

// ======== ADMIN: aprobar/rechazar Depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;

    const depId = Number(ctx.match[1]);
    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Calcula 90% al usuario (principal y saldo) y BRUTO = monto original
    const montoOriginal = numero(d.monto);        // en USDT
    const netoUser = montoOriginal * 0.90;        // 90% usuario
    const bonoRef = montoOriginal * 0.10;         // 10% patrocinador

    const car = await carteraDe(d.telegram_id);
    const nuevoPrincipal = numero(car.principal) + netoUser;
    const nuevoSaldo     = numero(car.saldo)     + netoUser;
    const nuevoBruto     = montoOriginal;        // base 500%

    await actualizarCartera(d.telegram_id, { principal: nuevoPrincipal, saldo: nuevoSaldo, bruto: nuevoBruto });

    // Pagar 10% a patrocinador, si existe
    try {
      const { data: uref } = await supabase.from('usuarios')
        .select('ref_by').eq('telegram_id', d.telegram_id).maybeSingle();
      const sponsor = Number(uref?.ref_by || 0);
      if (sponsor) {
        const carS = await carteraDe(sponsor);
        await actualizarCartera(sponsor, { saldo: numero(carS.saldo) + bonoRef });
        // Mensaje al sponsor
        try {
          await bot.telegram.sendMessage(
            sponsor,
            `🎁 Bono de referido: +${bonoRef.toFixed(2)} USDT (10% del depósito de ${d.telegram_id}).`
          );
        } catch {}
      }
    } catch (er) { console.log('Pago referido error:', er?.message || er); }

    // Marcar depósito
    await supabase.from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    // Mensajes
    await bot.telegram.sendMessage(
      d.telegram_id,
      '✅ Depósito aprobado\n' +
      `• Monto: ${montoOriginal.toFixed(2)} USDT\n` +
      `• Neto acreditado: ${netoUser.toFixed(2)} USDT\n` +
      `• Principal: ${nuevoPrincipal.toFixed(2)} USDT\n` +
      `• Disponible: ${nuevoSaldo.toFixed(2)} USDT\n` +
      `• Base 500%: ${nuevoBruto.toFixed(2)} USDT`
    );

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

// ======== ADMIN: aprobar/rechazar Retiro ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r || r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const car = await carteraDe(r.telegram_id);
    const totalDebitar = numero(r.monto) + RETIRO_FEE_USDT;
    if (totalDebitar > numero(car.saldo)) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: numero(car.saldo) - totalDebitar });
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
    await bot.telegram.sendMessage(ADMIN_GROUP_ID, `Retiro #${rid} RECHAZADO`);
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch (e) { console.log(e); }
});

// ======== /pagarhoy (ADMIN) — paga interés diario a todos ========
bot.command('pagarhoy', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('Solo el admin puede ejecutar este comando.');

    // Trae todas las carteras con principal > 0
    const { data: rows, error } = await supabase
      .from('carteras')
      .select('telegram_id, saldo, principal');
    if (error) throw error;

    let afectados = 0;
    let totalPagado = 0;

    for (const r of rows || []) {
      const principal = numero(r.principal ?? r.invertido);
      if (principal <= 0) continue;

      const rate = principal >= 500 ? 0.02 : 0.015;   // 2% o 1.5%
      const ganancia = principal * rate;

      await actualizarCartera(r.telegram_id, { saldo: numero(r.saldo) + ganancia });
      afectados += 1;
      totalPagado += ganancia;
    }

    await ctx.reply(`Pagados intereses a ${afectados} usuarios.\nTotal distribuido: ${totalPagado.toFixed(2)} USDT`);
  } catch (e) {
    console.log('ERROR pagarhoy:', e);
    try { await ctx.reply('Error ejecutando /pagarhoy'); } catch {}
  }
});

// ======== Webhook (Render) ========
const app = express();
app.use(express.json());

// Ruta secreta de webhook (usa parte del token para no exponer URL genérica)
const secretPath = `/webhook/${BOT_TOKEN.slice(0, 10)}`;
app.use(bot.webhookCallback(secretPath));

// Set webhook al arrancar
(async () => {
  try {
    await bot.telegram.setWebhook(`${HOST_URL}${secretPath}`);
    console.log('Webhook configurado:', `${HOST_URL}${secretPath}`);
  } catch (e) {
    console.log('Error setWebhook:', e?.description || e?.message || e);
  }
})();

app.get('/', (_, res) => res.send('FortunaMoney bot ✅ (webhook)'));

app.listen(PORT, () => {
  console.log(`HTTP on :${PORT} (${HOST_URL})`);
});

// Importante: NO usar bot.launch() con webhook
// process.once('SIGINT', () => bot.stop('SIGINT'));
// process.once('SIGTERM', () => bot.stop('SIGTERM'));
