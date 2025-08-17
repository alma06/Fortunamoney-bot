// ================== FortunaMoney Bot ==================
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
const estado = {}; // 'INV_USDT' | 'INV_CUP' | 'RET'

// ======== Helpers ========
const menu = () =>
  Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();

const numero = (x) => Number(x || 0);

async function asegurarUsuario(telegram_id) {
  // NO pisar si existe
  await supabase.from('usuarios').insert(
    [{ telegram_id }],
    { onConflict: 'telegram_id', ignoreDuplicates: true }
  );

  await supabase.from('carteras').insert(
    [{ telegram_id }],
    { onConflict: 'telegram_id', ignoreDuplicates: true }
  );
}

async function carteraDe(telegram_id) {
  const { data } = await supabase
    .from('carteras')
    .select('saldo, principal, invertido, bruto, ganado, ref_bonos')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  const saldo   = numero(data?.saldo);
  const prinRaw = (data?.principal !== undefined ? data.principal : data?.invertido);
  const principal = numero(prinRaw);
  const bruto  = numero(data?.bruto);
  const ganado = numero(data?.ganado);
  const ref_bonos = numero(data?.ref_bonos);

  return { saldo, principal, bruto, ganado, ref_bonos };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);

  const row = {
    telegram_id,
    saldo     : (patch.saldo     !== undefined) ? patch.saldo     : cur.saldo,
    principal : (patch.principal !== undefined) ? patch.principal : cur.principal,
    invertido : (patch.principal !== undefined) ? patch.principal : cur.principal,
    bruto     : (patch.bruto     !== undefined) ? patch.bruto     : cur.bruto,
    ganado    : (patch.ganado    !== undefined) ? patch.ganado    : cur.ganado,
    ref_bonos : (patch.ref_bonos !== undefined) ? patch.ref_bonos : cur.ref_bonos,
  };

  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

async function referrerDe(uid) {
  const { data } = await supabase
    .from('usuarios')
    .select('ref_by')
    .eq('telegram_id', uid)
    .maybeSingle();
  return data?.ref_by ? Number(data.ref_by) : null;
}

async function setReferrer(uid, maybeRef) {
  const ref = Number(maybeRef || 0);
  if (!ref || ref === uid) return;
  // sólo si aún no tiene
  const { data } = await supabase
    .from('usuarios')
    .select('ref_by')
    .eq('telegram_id', uid)
    .maybeSingle();
  if (data?.ref_by) return; // ya tiene

  // asegurar que el referidor existe
  await asegurarUsuario(ref);

  await supabase.from('usuarios').update({ ref_by: ref }).eq('telegram_id', uid);
}

// ======== UI: start / saldo / referidos ========
bot.start(async (ctx) => {
  const uid = ctx.from.id;

  // Capturar /start ref_<id>
  const text = ctx.message?.text || '';
  const m = text.match(/\/start(?:\s+|_)?ref[_ ]?(\d+)/i);
  if (m) {
    const refId = Number(m[1]);
    try { await setReferrer(uid, refId); } catch (e) { console.log('setReferrer:', e); }
  }

  await asegurarUsuario(uid);
  await ctx.reply('¡Bienvenido!', menu());
});

bot.hears('Saldo', async (ctx) => {
  const uid = ctx.from.id;
  await asegurarUsuario(uid);

  const { saldo, principal, bruto, ganado, ref_bonos } = await carteraDe(uid);
  const total = numero(saldo) + numero(principal);
  const tope500 = numero(bruto) * 5;
  const progreso = bruto > 0 ? ((ganado + ref_bonos) / tope500) * 100 : 0;

  await ctx.reply(
`Tu saldo (en USDT):

Principal (invertido):  ${principal.toFixed(2)}
Disponible:             ${saldo.toFixed(2)}
Total:                  ${total.toFixed(2)}

Base para 500% (BRUTO): ${bruto.toFixed(2)}
Tope 500%:              ${tope500.toFixed(2)}
Ganado (acumulado):     ${ganado.toFixed(2)}
Bonos referidos:        ${ref_bonos.toFixed(2)}
Progreso hacia 500%:    ${progreso.toFixed(2)}%`,
    menu()
  );
});

bot.hears('Referidos', async (ctx) => {
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${ctx.from.id}`;
  await ctx.reply(`Tu enlace de referido:\n${link}`);
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
  const uid = ctx.from.id;
  const car = await carteraDe(uid);
  estado[uid] = 'RET';
  await ctx.reply(
    `Tu saldo disponible es: ${numero(car.saldo).toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de Texto (monto) ========
bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  const st = estado[uid];
  const txt = (ctx.message.text || '').replace(',', '.');
  if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;

  const monto = Number(txt);
  if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

  // --- Inversión ---
  if (st === 'INV_USDT' || st === 'INV_CUP') {
    if (st === 'INV_USDT' && monto < MIN_INVERSION) {
      return ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
    }
    if (st === 'INV_CUP' && monto < 500) {
      return ctx.reply('El mínimo de inversión es 500 CUP.');
    }

    await asegurarUsuario(uid);

    let moneda = st === 'INV_USDT' ? 'USDT' : 'CUP';
    let montoFinalUSDT = monto;
    let tasa_usdt = null;

    if (st === 'INV_CUP') {
      tasa_usdt = CUP_USDT_RATE;
      montoFinalUSDT = monto / tasa_usdt;
    }

    const ins = await supabase.from('depositos').insert([{
      telegram_id: uid,
      monto: montoFinalUSDT,     // USDT equivalentes
      moneda,
      monto_origen: monto,       // lo que el usuario dijo
      tasa_usdt,
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) return ctx.reply('Error guardando depósito.');

    const depId = ins.data.id;
    const instrucciones = (moneda === 'USDT')
      ? `Método: USDT (BEP20)\n- Wallet: ${WALLET_USDT}`
      : `Método: CUP (Tarjeta)\n- Número de tarjeta: ${WALLET_CUP}`;

    await ctx.reply(
      `✅ Depósito creado (pendiente).\n\n` +
      `ID: ${depId}\n` +
      `Monto: ${monto.toFixed(2)} ${moneda}\n` +
      (moneda === 'CUP' ? `Equivalente: ${montoFinalUSDT.toFixed(2)} USDT\n` : '') +
      `${instrucciones}\n\n` +
      `• Envía el hash de la transacción (USDT) o una foto del pago (CUP).\n` +
      `• Cuando el admin confirme la recepción, tu inversión será acreditada.`,
      menu()
    );

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `📩 DEPÓSITO pendiente\nID: #${depId}\nUser: ${uid}\n` +
      `Monto: ${monto.toFixed(2)} ${moneda}\n` +
      `Eq: ${montoFinalUSDT.toFixed(2)} USDT`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
            [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
          ]
        }
      }
    );

    estado[uid] = null;
    return;
  }

  // --- Retiro ---
  if (st === 'RET') {
    const car = await carteraDe(uid);
    const totalDebitar = monto + RETIRO_FEE_USDT;
    if (totalDebitar > car.saldo) return ctx.reply('Saldo insuficiente.');

    const ins = await supabase.from('retiros').insert([{
      telegram_id: uid,
      monto,
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) return ctx.reply('Error creando retiro.');
    const retId = ins.data.id;

    await ctx.reply(`✅ Retiro creado (pendiente).\nID: ${retId}\nMonto: ${monto.toFixed(2)} USDT\nFee: ${RETIRO_FEE_USDT} USDT`);

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `🆕 RETIRO pendiente\nID: #${retId}\nUser: ${uid}\nMonto: ${monto.toFixed(2)} USDT`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
            [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}` }]
          ]
        }
      }
    );

    estado[uid] = null;
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

    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      '🔗 Hash recibido\n' +
      `Depósito: #${depId}\nUser: ${ctx.from.id}\nHash: ${hash}`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
        [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
      ]}}
    );

    await ctx.reply('Hash agregado al depósito.');
  } catch (e) { console.log(e); }
});

// ======== ADMIN: aprobar / rechazar depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const carPrev = await carteraDe(d.telegram_id);

    const monto = numero(d.monto);            // USDT equivalentes
    const principalAcreditar = monto * 0.90;  // 90%
    const brutoAcreditar     = monto;         // 100% a base 500
    const nuevoPrincipal     = numero(carPrev.principal) + principalAcreditar;
    const nuevoBruto         = numero(carPrev.bruto) + brutoAcreditar;
    const nuevoSaldo         = numero(carPrev.saldo); // NO tocar disponible aquí

    await actualizarCartera(d.telegram_id, {
      principal: nuevoPrincipal,
      bruto: nuevoBruto,
      saldo: nuevoSaldo
    });

    // Bono referidor (10% a saldo y a ref_bonos del referidor)
    const ref = await referrerDe(d.telegram_id);
    if (ref && ref !== d.telegram_id) {
      const carRef = await carteraDe(ref);
      const bono = monto * 0.10;
      await actualizarCartera(ref, {
        saldo: numero(carRef.saldo) + bono,
        ref_bonos: numero(carRef.ref_bonos) + bono
      });
      try {
        await bot.telegram.sendMessage(ref,
          `🎁 Bono de referido: +${bono.toFixed(2)} USDT\n` +
          `Tu disponible ahora: ${(numero(carRef.saldo)+bono).toFixed(2)} USDT`);
      } catch {}
    }

    await supabase.from('depositos').update({
      estado: 'aprobado',
      aprobado_en: new Date().toISOString()
    }).eq('id', depId);

    // Aviso al usuario
    await bot.telegram.sendMessage(
      d.telegram_id,
      `✅ Depósito aprobado\n` +
      `• Monto: ${monto.toFixed(2)} USDT\n` +
      `• Neto acreditado: ${principalAcreditar.toFixed(2)} USDT\n` +
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

// ======== ADMIN: aprobar / rechazar retiro ========
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

    await supabase.from('retiros').update({
      estado: 'aprobado',
      aprobado_en: new Date().toISOString()
    }).eq('id', rid);

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

// ======== PAGO DIARIO: /pagarhoy y /pagarahora (admin) ========
async function pagarHoy(ctx) {
  const dow = new Date().getDay(); // 0 Dom, 1 Lun, ... 6 Sáb
  if (dow === 1) return ctx.reply('Hoy es Lunes. No se paga.');

  const { data: rows, error } = await supabase
    .from('carteras')
    .select('telegram_id, saldo, principal, bruto, ganado, ref_bonos');

  if (error) {
    console.log(error);
    return ctx.reply('Error leyendo carteras.');
  }

  let totalPagado = 0;
  let usuariosPagados = 0;

  for (const row of rows || []) {
    const uid       = row.telegram_id;
    const principal = numero(row.principal);
    const bruto     = numero(row.bruto);
    const saldo     = numero(row.saldo);
    const ganado    = numero(row.ganado);
    const ref_bonos = numero(row.ref_bonos);

    if (bruto <= 0 || principal <= 0) continue;

    const rate = bruto < 500 ? 0.015 : 0.02;
    let pago = principal * rate;

    const tope = bruto * 5;
    const acumulado = ganado + ref_bonos;
    const margen = tope - acumulado;
    if (margen <= 0) continue;

    if (pago > margen) pago = margen;
    if (pago <= 0) continue;

    await actualizarCartera(uid, {
      saldo : saldo + pago,
      ganado: ganado + pago
    });

    totalPagado += pago;
    usuariosPagados += 1;
  }

  await ctx.reply(`Pago diario completado.\nUsuarios pagados: ${usuariosPagados}\nTotal pagado: ${totalPagado.toFixed(2)} USDT`);
}

bot.command(['pagarhoy', 'pagarahora'], async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Solo admin.');
  try { await pagarHoy(ctx); } catch (e) { console.log(e); ctx.reply('Error pagando.'); }
});

// ======== Webhook / Ping ========
app.get('/', (_, res) => res.send('OK'));
app.post('/webhook', (req, res) => res.sendStatus(200));

app.listen(PORT, async () => {
  console.log(`HTTP on :${PORT} ${HOST_URL ? `(${HOST_URL})` : ''}`);
  bot.launch();
  console.log('Bot lanzado.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
