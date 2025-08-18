// ================== FortunaMoney Bot (COMPLETO) ==================
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ======== ENV ========
const BOT_TOKEN       = process.env.BOT_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const ADMIN_ID        = Number(process.env.ADMIN_ID || 0);
const ADMIN_GROUP_ID  = Number(process.env.ADMIN_GROUP_ID || 0);
const WALLET_USDT     = process.env.WALLET_USDT || 'WALLET_NO_CONFIGURADA';
const WALLET_CUP      = process.env.WALLET_CUP  || 'TARJETA_NO_CONFIGURADA';
const HOST_URL        = process.env.HOST_URL || '';
const CRON_SECRET     = process.env.CRON_SECRET || 'cambia_esto';
const PORT            = Number(process.env.PORT || 3000);

// Reglas
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25); // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE  || 400); // 1 USDT = 400 CUP

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID) {
  console.log('Faltan variables de entorno obligatorias (BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, ADMIN_ID, ADMIN_GROUP_ID).');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado en memoria ========
const estado = {}; // 'INV_USDT' | 'INV_CUP' | 'RET'

// ======== Helpers ========
const numero = (x) => Number(x || 0) || 0;

function menu() {
  return Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
}

async function asegurarUsuario(telegram_id, patrocinador_id = null) {
  try {
    // usuario
    const { data: u } = await supabase.from('usuarios')
      .select('telegram_id, patrocinador_id')
      .eq('telegram_id', telegram_id)
      .maybeSingle();

    let up = null;
    if (!u) {
      up = { telegram_id };
      if (patrocinador_id && Number(patrocinador_id) !== Number(telegram_id)) {
        up.patrocinador_id = patrocinador_id;
      }
    } else if (!u.patrocinador_id && patrocinador_id && Number(patrocinador_id) !== Number(telegram_id)) {
      up = { telegram_id, patrocinador_id };
    }
    if (up) await supabase.from('usuarios').upsert([up], { onConflict: 'telegram_id' });

    // cartera
    await supabase.from('carteras').upsert([
      { telegram_id, saldo: 0, principal: 0, invertido: 0, bruto: 0 }
    ], { onConflict: 'telegram_id' });

  } catch (e) {
    console.log('asegurarUsuario error:', e);
  }
}

async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, invertido, bruto')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  const saldo   = numero(data?.saldo);
  const prinRaw = (data?.principal !== undefined ? data.principal : data?.invertido);
  const principal = numero(prinRaw);
  const bruto  = numero(data?.bruto);

  return { saldo, principal, bruto };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);

  const nuevoSaldo     = (patch.saldo     !== undefined) ? patch.saldo     : cur.saldo;
  const nuevoPrincipal = (patch.principal !== undefined) ? patch.principal : cur.principal;
  const nuevoBruto     = (patch.bruto     !== undefined) ? patch.bruto     : cur.bruto;

  await supabase.from('carteras').upsert([{
    telegram_id,
    saldo: nuevoSaldo,
    principal: nuevoPrincipal,
    invertido: nuevoPrincipal, // compat.
    bruto: nuevoBruto
  }], { onConflict: 'telegram_id' });
}

async function totalRetiradoAprobado(telegram_id) {
  const { data } = await supabase.from('retiros')
    .select('monto')
    .eq('telegram_id', telegram_id)
    .eq('estado', 'aprobado');
  let s = 0;
  (data || []).forEach(r => s += numero(r.monto));
  return s;
}

function tasaSegunBruto(brutoTotal) {
  return brutoTotal >= 500 ? 0.02 : 0.015;
}
function tope500(bruto) { return bruto * 5.0; }
function brutoDesdePrincipal(principalTotal) {
  // bruto = principal_net / 0.9 (siempre)
  return principalTotal > 0 ? (principalTotal / 0.9) : 0;
}

// ======== START con referidos ========
bot.start(async (ctx) => {
  try {
    const uid = ctx.from.id;
    let sponsorId = null;

    // Deep-link payload: /start ref_123
    const text = ctx.message?.text || '';
    const parts = text.split(' ');
    if (parts.length > 1 && parts[1].startsWith('ref_')) {
      const raw = parts[1].slice(4);
      const n = Number(raw);
      if (!isNaN(n) && n > 0) sponsorId = n;
    }

    await asegurarUsuario(uid, sponsorId);

    const link = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
    await ctx.reply(
      '¡Bienvenido a FortunaMoney! ✅\n\n' +
      'Usa el menú para invertir, retirar o ver tu saldo.\n\n' +
      'Tu enlace de referido:\n' + link,
      menu()
    );
  } catch (e) {
    console.log('start error:', e);
    try { await ctx.reply('Hubo un error al iniciar.'); } catch {}
  }
});

// ======== Saldo ========
bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const { saldo, principal, bruto } = await carteraDe(chatId);
    const total = numero(saldo) + numero(principal);
    const tope = tope500(bruto);
    const retirado = await totalRetiradoAprobado(chatId);
    const pagadoHastaAhora = saldo + retirado; // lo que ya está en disponible + lo que ya retiró
    const progreso = tope > 0 ? Math.min(100, (pagadoHastaAhora / tope) * 100) : 0;

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${principal.toFixed(2)}\n` +
      `Disponible:             ${saldo.toFixed(2)}\n` +
      `Total:                  ${total.toFixed(2)}\n\n` +
      `Bruto (base 500%):      ${bruto.toFixed(2)}\n` +
      `Tope de pago (500%):    ${tope.toFixed(2)}\n` +
      `Progreso al 500%:       ${progreso.toFixed(2)}%`,
      menu()
    );
  } catch (e) {
    console.log('Saldo error:', e);
    try { await ctx.reply('Error obteniendo tu saldo.'); } catch {}
  }
});

// ======== Referidos ========
bot.hears('Referidos', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const { data } = await supabase.from('usuarios')
      .select('telegram_id')
      .eq('patrocinador_id', chatId);

    const link = `https://t.me/${ctx.botInfo.username}?start=ref_${chatId}`;
    await ctx.reply(
      `👥 Referidos: ${data?.length || 0}\n\n` +
      `Tu enlace: ${link}`,
      menu()
    );
  } catch (e) {
    console.log('Referidos error:', e);
  }
});

// ======== Invertir ========
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

// ======== Retirar ========
bot.hears('Retirar', async (ctx) => {
  const chatId = ctx.from.id;
  const car = await carteraDe(chatId);
  estado[chatId] = 'RET';
  await ctx.reply(
    `Tu saldo disponible es: ${numero(car.saldo).toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT (además del monto solicitado)\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de Texto (montos) ========
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const st = estado[chatId];
    const raw = (ctx.message.text || '').trim();
    if (raw.startsWith('/')) return;
    if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;

    const monto = Number(raw.replace(',', '.'));
    if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

    // --- Invertir ---
    if (st === 'INV_USDT' || st === 'INV_CUP') {
      if (st === 'INV_USDT' && monto < MIN_INVERSION) {
        return ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
      }
      if (st === 'INV_CUP' && monto < 500) {
        return ctx.reply('El mínimo de inversión es 500 CUP.');
      }

      await asegurarUsuario(chatId);

      let moneda = (st === 'INV_USDT') ? 'USDT' : 'CUP';
      let monto_origen = monto;
      let tasa_usdt = null;
      let montoUSDT = monto;

      if (st === 'INV_CUP') {
        tasa_usdt = CUP_USDT_RATE;
        montoUSDT = monto / tasa_usdt; // equivalente USDT
      }

      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: montoUSDT,       // siempre guardamos en USDT equivalentes
        moneda,                 // 'USDT' / 'CUP'
        monto_origen,           // lo que escribió el user
        tasa_usdt,              // null si USDT
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) {
        console.log('insert dep error:', ins.error);
        await ctx.reply('Error guardando el depósito.');
        return;
      }

      const depId = ins.data.id;
      const instrucciones = (moneda === 'USDT')
        ? `Método: USDT (BEP20)\nWallet: ${WALLET_USDT}`
        : `Método: CUP (Tarjeta)\nTarjeta: ${WALLET_CUP}`;

      await ctx.reply(
        `✅ Depósito creado (pendiente).\n\n` +
        `ID: ${depId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${montoUSDT.toFixed(2)} USDT\n` : '') +
        `${instrucciones}\n\n` +
        `• Envía el hash (USDT) o una foto del pago (CUP).\n` +
        `• Cuando el admin confirme, tu inversión será acreditada.`,
        menu()
      );

      // Aviso al admin
      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `📥 DEPÓSITO pendiente\n` +
          `ID: #${depId}\n` +
          `User: ${chatId}\n` +
          `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
          (moneda === 'CUP' ? `Eq: ${montoUSDT.toFixed(2)} USDT\n` : ``) +
          `Usa los botones:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
                [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
              ]
            }
          }
        );
      } catch (e2) {
        console.log('No pude avisar admin deposito:', e2?.message || e2);
      }

      estado[chatId] = undefined;
      return;
    }

    // --- Retirar ---
    if (st === 'RET') {
      const fee = RETIRO_FEE_USDT;
      const car = await carteraDe(chatId);
      const disp = numero(car.saldo);
      const totalDebitar = monto + fee;

      if (totalDebitar > disp) {
        await ctx.reply(
          `Saldo insuficiente.\n` +
          `Disponible: ${disp.toFixed(2)} USDT\n` +
          `Necesario: ${totalDebitar.toFixed(2)} USDT (monto + fee)`
        );
        estado[chatId] = undefined;
        return;
      }

      const insR = await supabase.from('retiros').insert([{
        telegram_id: chatId,
        monto,
        estado: 'pendiente'
      }]).select('id').single();

      if (insR.error) { await ctx.reply('No se pudo crear el retiro.'); return; }

      const retId = insR.data.id;
      await ctx.reply(
        `✅ Retiro creado (pendiente).\n\n` +
        `ID: ${retId}\n` +
        `Monto: ${monto.toFixed(2)} USDT\n` +
        `Fee: ${fee.toFixed(2)} USDT`,
        menu()
      );

      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `🆕 RETIRO pendiente\n` +
          `ID: #${retId}\n` +
          `Usuario: ${chatId}\n` +
          `Monto: ${monto.toFixed(2)} USDT\n` +
          `Fee: ${fee.toFixed(2)} USDT`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
                [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}`  }]
              ]
            }
          }
        );
      } catch (e3) { console.log('No avisé admin retiro:', e3?.message || e3); }

      estado[chatId] = undefined;
      return;
    }
  } catch (e) {
    console.log('Handler texto error:', e);
    try { await ctx.reply('Ocurrió un error procesando tu mensaje.'); } catch {}
  }
});

// ======== Foto: guardar comprobante en depósito pendiente más reciente ========
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

    if (!dep) return ctx.reply('No encuentro un depósito pendiente.');

    await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
    await ctx.reply(`Comprobante guardado (#${dep.id}).`);

    try {
      await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
        caption: `🧾 DEPÓSITO\nID: ${dep.id}\nUser: ${uid}`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aprobar',  callback_data: `dep:approve:${dep.id}` }],
            [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}`  }]
          ]
        }
      });
    } catch (e2) { console.log('Foto admin error:', e2?.message || e2); }
  } catch (e) { console.log('photo error:', e); }
});

// ======== /tx: agregar hash ========
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

    await ctx.reply('Hash agregado al depósito.');
    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `🔗 Hash recibido\nDepósito: #${depId}\nUser: ${ctx.from.id}\nHash: ${hash}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
            [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
          ]
        }
      }
    );
  } catch (e) { console.log('tx error:', e); }
});

// ======== ADMIN: listar pendientes ========
bot.command('pendientes', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const { data, error } = await supabase.from('depositos')
    .select('id, telegram_id, monto, moneda, monto_origen, tx, proof_file_id')
    .eq('estado', 'pendiente')
    .order('id', { ascending: true });

  if (error) return ctx.reply('Error listando pendientes.');
  if (!data || data.length === 0) return ctx.reply('Sin depósitos pendientes.');

  let msg = 'Depósitos pendientes:\n';
  data.forEach(d => {
    msg += `#${d.id} | user ${d.telegram_id} | ${numero(d.monto).toFixed(2)} USDT (orig ${numero(d.monto_origen).toFixed(2)} ${d.moneda}) | hash: ${d.tx?'SI':'NO'} | foto: ${d.proof_file_id?'SI':'NO'}\n`;
  });
  await ctx.reply(msg);
});

// ======== ADMIN: aprobar dep (90% principal al usuario, 10% bono sponsor) ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Datos
    const userId = d.telegram_id;
    const montoUSDT = numero(d.monto);

    // 90% a principal user
    const carUser = await carteraDe(userId);
    const principalNuevo = numero(carUser.principal) + (montoUSDT * 0.90);
    const saldoNuevoUser = numero(carUser.saldo); // principal NO va a disponible
    const brutoNuevo     = brutoDesdePrincipal(principalNuevo);

    await actualizarCartera(userId, {
      principal: principalNuevo,
      saldo: saldoNuevoUser,
      bruto: brutoNuevo
    });

    // 10% al sponsor (si existe)
    try {
      const { data: u } = await supabase.from('usuarios')
        .select('patrocinador_id')
        .eq('telegram_id', userId)
        .maybeSingle();
      const sponsorId = u?.patrocinador_id || null;

      if (sponsorId) {
        const carS = await carteraDe(sponsorId);
        const bono = montoUSDT * 0.10; // retirable
        await actualizarCartera(sponsorId, { saldo: numero(carS.saldo) + bono });
        try {
          await bot.telegram.sendMessage(
            sponsorId,
            `🎉 Bono de referido acreditado: ${bono.toFixed(2)} USDT\nPor el depósito de tu referido ${userId}.`
          );
        } catch {}
      }
    } catch (eS) { console.log('sponsor error:', eS); }

    // Marcar dep aprobado
    await supabase.from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    // Aviso user
    try {
      await bot.telegram.sendMessage(
        userId,
        `Depósito aprobado: ${montoUSDT.toFixed(2)} USDT.\n` +
        `A tu principal se acreditó: ${(montoUSDT*0.90).toFixed(2)} USDT.\n` +
        `Bruto (base 500%): ${brutoNuevo.toFixed(2)} USDT.`
      );
    } catch (eMsg) { console.log('avisar user err:', eMsg?.message || eMsg); }

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} aprobado.`);
  } catch (e) {
    console.log('dep approve error:', e);
  }
});

bot.action(/dep:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('telegram_id, estado').eq('id', depId).single();
    if (!d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
    try { await bot.telegram.sendMessage(d.telegram_id, `Tu depósito #${depId} fue RECHAZADO.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} rechazado.`);
  } catch (e) { console.log('dep reject error:', e); }
});

// ======== ADMIN: aprobar / rechazar retiro ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const car = await carteraDe(r.telegram_id);
    const totalDebitar = numero(r.monto) + RETIRO_FEE_USDT;
    if (totalDebitar > numero(car.saldo)) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: numero(car.saldo) - totalDebitar });
    await supabase.from('retiros').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log('ret approve error:', e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('telegram_id, estado, monto').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // devolver solo monto (fee no se devuelve)
    const car = await carteraDe(r.telegram_id);
    await actualizarCartera(r.telegram_id, { saldo: numero(car.saldo) + numero(r.monto) });

    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);
    try { await bot.telegram.sendMessage(r.telegram_id, `❌ Tu retiro #${rid} fue RECHAZADO. Monto devuelto.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado y monto devuelto.`);
  } catch (e) { console.log('ret reject error:', e); }
});

// ======== PAGO DIARIO MANUAL (/pagarhoy) ========
bot.command('pagarhoy', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return; // solo admin

    // obtener todas las carteras
    const { data: carteras, error } = await supabase.from('carteras')
      .select('telegram_id, saldo, principal, invertido, bruto');

    if (error) {
      console.log('list carteras err:', error);
      return ctx.reply('Error listando carteras');
    }

    let pagados = 0;

    for (const c of (carteras || [])) {
      const uid        = c.telegram_id;
      const principal  = numero(c.principal !== undefined ? c.principal : c.invertido);
      if (principal <= 0) continue;

      // bruto total recalculado por si acaso
      const brutoTotal = numero(c.bruto) || brutoDesdePrincipal(principal);
      const pct        = tasaSegunBruto(brutoTotal);
      const interes    = principal * pct;

      const saldo      = numero(c.saldo);
      const retirado   = await totalRetiradoAprobado(uid);
      const tope       = tope500(brutoTotal);
      const pagadoHastaAhora = saldo + retirado;

      if (pagadoHastaAhora >= tope) continue; // ya llegó al tope

      const margen = tope - pagadoHastaAhora;
      const pago   = interes > margen ? margen : interes; // no pasarse del tope
      const nuevoSaldo = saldo + pago;

      await actualizarCartera(uid, { saldo: nuevoSaldo, bruto: brutoTotal });

      // avisar usuario
      try {
        await bot.telegram.sendMessage(
          uid,
          `💸 Pago diario acreditado: ${pago.toFixed(2)} USDT (tasa ${(pct*100).toFixed(2)}%).\n` +
          `Disponible: ${nuevoSaldo.toFixed(2)} USDT.`
        );
      } catch (eMsg) { console.log('no pude avisar a', uid, eMsg?.message || eMsg); }

      pagados++;
    }

    await ctx.reply(`Pago diario ejecutado. Usuarios pagados: ${pagados}`);
  } catch (e) {
    console.log('pagarhoy error:', e);
    try { await ctx.reply('Error en pagarhoy'); } catch {}
  }
});

// ======== Webhook y HTTP ========
app.get('/', (_req, res) => res.send('OK'));

// endpoint opcional para cron externo
app.get('/run-pago', async (req, res) => {
  const key = req.query.key || '';
  if (key !== CRON_SECRET) return res.status(403).send('Forbidden');
  // Reutilizamos la lógica de /pagarhoy llamando el bot.command programáticamente no es trivial aquí,
  // así que duplicarías o factorizarías la lógica si quieres usar este endpoint.
  res.send('Configura /pagarhoy desde Telegram para pago manual.');
});

// Webhook de Telegram
const webhookPath = `/webhook/${BOT_TOKEN}`;
app.get(webhookPath, (_req, res) => res.status(200).send('OK'));
app.post(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));

// ===== Arranque =====
app.listen(PORT, async () => {
  console.log('HTTP server on port', PORT);
  try {
    if (HOST_URL) {
      const url = `${HOST_URL}${webhookPath}`;
      await bot.telegram.setWebhook(url);
      console.log('Webhook configurado en:', url);
    } else {
      await bot.launch();
      console.log('Bot lanzado en modo polling (HOST_URL no definido)');
    }
  } catch (e) {
    console.log('Error configurando webhook/polling:', e.message);
  }
});

// Parada limpia
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
