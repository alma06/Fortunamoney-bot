// ================== FortunaMoney Bot (completo) ==================
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
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25);   // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);  // USDT
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
function menu() {
  return Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
}
function numero(x) { return Number(x || 0) || 0; }

async function asegurarUsuario(telegram_id) {
  await supabase.from('usuarios').upsert([{ telegram_id }], { onConflict: 'telegram_id' });
  // carteras: saldo (retirable), principal (no retirable), bruto (base 500%), ganado (intereses), bonos (referidos)
  await supabase.from('carteras').upsert(
    [{ telegram_id, saldo: 0, principal: 0, invertido: 0, bruto: 0, ganado: 0, bonos: 0 }],
    { onConflict: 'telegram_id' }
  );
}

async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, invertido, bruto, ganado, bonos')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  const saldo   = numero(data?.saldo);
  const prinRaw = (data?.principal !== undefined ? data.principal : data?.invertido);
  const principal = numero(prinRaw);
  const bruto  = numero(data?.bruto);
  const ganado = numero(data?.ganado);
  const bonos  = numero(data?.bonos);

  return { saldo, principal, bruto, ganado, bonos };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);
  const upd = {
    telegram_id,
    saldo:     (patch.saldo     !== undefined) ? numero(patch.saldo)     : cur.saldo,
    principal: (patch.principal !== undefined) ? numero(patch.principal) : cur.principal,
    invertido: (patch.principal !== undefined) ? numero(patch.principal) : cur.principal, // compat
    bruto:     (patch.bruto     !== undefined) ? numero(patch.bruto)     : cur.bruto,
    ganado:    (patch.ganado    !== undefined) ? numero(patch.ganado)    : cur.ganado,
    bonos:     (patch.bonos     !== undefined) ? numero(patch.bonos)     : cur.bonos
  };
  await supabase.from('carteras').upsert([upd], { onConflict: 'telegram_id' });
}

async function patrocinadorDe(userId) {
  const { data, error } = await supabase
    .from('referidos')
    .select('patrocinador_id')
    .eq('referido_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data.patrocinador_id || null;
}

function tasaSegunBruto(bruto) {
  return bruto >= 500 ? 0.02 : 0.015;
}

function tope500(bruto) {
  return numero(bruto) * 5.0;
}

// ======== START / SALDO / REFERIDOS ========
bot.start(async (ctx) => {
  await asegurarUsuario(ctx.from.id);

  // Soporte de referidos: /start ref_12345
  try {
    const text = ctx.message?.text || '';
    const partes = text.split(' ');
    if (partes.length > 1 && partes[1].startsWith('ref_')) {
      const patroId = Number(partes[1].slice(4));
      if (patroId && patroId !== ctx.from.id) {
        // registrar si no existe
        const { data: ya } = await supabase.from('referidos')
          .select('id').eq('referido_id', ctx.from.id).maybeSingle();
        if (!ya) {
          await supabase.from('referidos').insert([{ patrocinador_id: patroId, referido_id: ctx.from.id }]);
        }
      }
    }
  } catch (_) {}

  await ctx.reply('¡Bienvenido a FortunaMoney!', menu());
});

bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const { saldo, principal, bruto, ganado, bonos } = await carteraDe(chatId);
    const total = principal + saldo;
    const tope  = tope500(bruto);
    const avance = numero(ganado + bonos); // ambos aceleran el 500%
    const progreso = tope > 0 ? Math.min(100, (avance / tope) * 100) : 0;

    await ctx.reply(
      '📊 *Tu saldo (USDT)*\n\n' +
      `• Principal (invertido):  ${principal.toFixed(2)}\n` +
      `• Disponible (retirable): ${saldo.toFixed(2)}\n` +
      `• Total:                  ${total.toFixed(2)}\n\n` +
      `• Bruto (base 500%):      ${bruto.toFixed(2)}\n` +
      `• Ganado (intereses):     ${ganado.toFixed(2)}\n` +
      `• Bonos (referidos):      ${bonos.toFixed(2)}\n` +
      `• Progreso 500%:          ${progreso.toFixed(2)}%`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.log('ERROR Saldo:', e);
    try { await ctx.reply('Error obteniendo tu saldo. Intenta de nuevo.'); } catch {}
  }
});

bot.hears('Referidos', async (ctx) => {
  try {
    const uname = ctx.botInfo?.username || 'FortunaMoneyBot';
    const link = `https://t.me/${uname}?start=ref_${ctx.from.id}`;
    await ctx.reply(`🔗 Tu enlace de referido:\n${link}\n\nGanas 10% de cada inversión que haga tu invitado (retirable).`);
  } catch (e) { console.log(e); }
});

// ======== INVERTIR ========
bot.hears('Invertir', async (ctx) => {
  await ctx.reply('Elige método de inversión:', Markup.inlineKeyboard([
    [{ text: 'USDT (BEP20)', callback_data: 'inv:usdt' }],
    [{ text: 'CUP (Tarjeta)', callback_data: 'inv:cup' }],
  ]));
});

bot.action('inv:usdt', async (ctx) => {
  estado[ctx.from.id] = 'INV_USDT';
  await ctx.answerCbQuery();
  await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}). Ej: 50.00`);
});

bot.action('inv:cup', async (ctx) => {
  estado[ctx.from.id] = 'INV_CUP';
  await ctx.answerCbQuery();
  await ctx.reply('Escribe el monto a invertir en CUP (mínimo 500). Ej: 20000');
});

// ======== RETIRAR ========
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

// ======== HANDLER ÚNICO DE TEXTO (MONTOS) ========
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const raw = (ctx.message?.text || '').trim();
    if (raw.startsWith('/')) return;

    const st = estado[chatId];
    if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;

    const monto = Number(raw.replace(',', '.'));
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
      const monto_origen = monto;
      const tasa_usdt = (st === 'INV_CUP') ? CUP_USDT_RATE : null;
      const monto_usdt = (st === 'INV_CUP') ? (monto_origen / tasa_usdt) : monto_origen; // BRUTO USDT

      // Guardar depósito pendiente (monto en USDT equivalentes = bruto)
      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: monto_usdt,      // este es el BRUTO en USDT equiv
        moneda,
        monto_origen,
        tasa_usdt,
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) {
        console.log('Error insert depósito:', ins.error);
        return ctx.reply('Error guardando el depósito.');
      }

      const depId = ins.data.id;
      const instrucciones = (moneda === 'USDT')
        ? `Método: USDT (BEP20)\n- Wallet: ${WALLET_USDT}`
        : `Método: CUP (Tarjeta)\n- Número de tarjeta: ${WALLET_CUP}`;

      await ctx.reply(
        `✅ Depósito creado (pendiente).\n\n` +
        `ID: ${depId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${monto_usdt.toFixed(2)} USDT\n` : '') +
        `${instrucciones}\n\n` +
        `• Envía el hash de la transacción (USDT) o una foto/captura del pago (CUP).\n` +
        `• Cuando el admin confirme, tu inversión será acreditada.`,
        menu()
      );

      // Aviso admin
      try {
        const body =
          `📥 DEPÓSITO pendiente\n` +
          `ID: #${depId}\n` +
          `User: ${chatId}\n` +
          `Monto org: ${monto_origen.toFixed(2)} ${moneda}\n` +
          `BRUTO USDT: ${monto_usdt.toFixed(2)}\n` +
          `Usa los botones para validar.`;
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          body,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
                [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
              ]
            }
          }
        );
      } catch (e2) { console.log('Aviso admin error:', e2?.message || e2); }

      estado[chatId] = undefined;
      return;
    }

    // --- Retiro ---
    if (st === 'RET') {
      const car = await carteraDe(chatId);
      const totalDebitar = monto + RETIRO_FEE_USDT;
      if (totalDebitar > car.saldo) {
        estado[chatId] = undefined;
        return ctx.reply('Saldo insuficiente para ese retiro.');
      }

      const insR = await supabase.from('retiros').insert([{
        telegram_id: chatId,
        monto,
        estado: 'pendiente'
      }]).select('id').single();

      if (insR.error) return ctx.reply('No se pudo crear el retiro.');

      const retId = insR.data.id;
      await ctx.reply(
        `✅ Retiro creado (pendiente).\n` +
        `ID: ${retId}\n` +
        `Monto: ${monto.toFixed(2)} USDT\n` +
        `Fee descontado al aprobar: ${RETIRO_FEE_USDT.toFixed(2)} USDT`,
        menu()
      );

      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `🆕 RETIRO pendiente\nID: #${retId}\nUser: ${chatId}\nMonto: ${monto.toFixed(2)} USDT`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
                [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}`  }]
              ]
            }
          }
        );
      } catch (e3) { console.log('Aviso admin retiro error:', e3?.message || e3); }

      estado[chatId] = undefined;
      return;
    }
  } catch (e) {
    console.log('Error en handler de texto:', e);
    try { await ctx.reply('Ocurrió un error procesando tu mensaje.'); } catch {}
  }
});

// ======== FOTO: comprobante -> adjunta a último depósito pendiente ========
bot.on('photo', async (ctx) => {
  try {
    const uid = ctx.from.id;
    const photos = ctx.message.photo || [];
    if (!photos.length) return;
    const fileId = photos[photos.length - 1].file_id;

    const { data: dep } = await supabase.from('depositos')
      .select('id, estado')
      .eq('telegram_id', uid).eq('estado', 'pendiente')
      .order('id', { ascending: false }).limit(1).maybeSingle();

    if (!dep) return ctx.reply('No encuentro un depósito pendiente para guardar tu comprobante.');

    await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
    await ctx.reply(`Comprobante guardado para el depósito #${dep.id}.`);

    // Enviar al admin
    try {
      await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
        caption: `🧾 Comprobante DEPÓSITO #${dep.id}\nUser: ${uid}`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aprobar',  callback_data: `dep:approve:${dep.id}` }],
            [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}`  }]
          ]
        }
      });
    } catch (e2) { console.log('No pude mandar foto al admin:', e2?.message || e2); }
  } catch (e) { console.log('Handler foto error:', e); }
});

// ======== ADMIN: aprobar/rechazar DEPÓSITO ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const userId   = d.telegram_id;
    const brutoAdd = numero(d.monto);           // BRUTO USDT equivalente
    const netoAdd  = +(brutoAdd * 0.90).toFixed(8); // 90% al principal (no retirable)
    const bonoRef  = +(brutoAdd * 0.10).toFixed(8); // 10% al patrocinador (disponible)

    // Acreditar al inversionista: principal += 90%, bruto += 100%
    const carU = await carteraDe(userId);
    await actualizarCartera(userId, {
      principal: carU.principal + netoAdd,
      bruto:     carU.bruto + brutoAdd
      // saldo NO se toca aquí
    });

    // Pagar bono a patrocinador (si existe)
    const patroId = await patrocinadorDe(userId);
    if (patroId && bonoRef > 0) {
      await asegurarUsuario(patroId);
      const carP = await carteraDe(patroId);
      await actualizarCartera(patroId, {
        saldo: carP.saldo + bonoRef,
        bonos: carP.bonos + bonoRef
      });
      // Avisar al patrocinador
      try {
        await bot.telegram.sendMessage(
          patroId,
          `🎉 Bono de referido: +${bonoRef.toFixed(2)} USDT\n` +
          `Por el depósito aprobado de tu invitado (${userId}).`
        );
      } catch (e2) { console.log('No pude avisar al patrocinador:', e2?.message || e2); }
    }

    // Marcar depósito aprobado
    await supabase.from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    // Avisar al usuario
    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ Depósito aprobado.\n` +
        `Bruto: ${brutoAdd.toFixed(2)} USDT\n` +
        `Acreditado a principal (90%): +${netoAdd.toFixed(2)} USDT\n` +
        `Bruto acumulado (base 500%): ${(carU.bruto + brutoAdd).toFixed(2)} USDT`
      );
    } catch (e3) { console.log('No pude avisar al usuario:', e3?.message || e3); }

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} aprobado.`);
  } catch (e) { console.log('dep:approve error:', e); }
});

bot.action(/dep:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);
    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
    try { await bot.telegram.sendMessage(d.telegram_id, `❌ Tu depósito #${depId} fue RECHAZADO.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} rechazado.`);
  } catch (e) { console.log('dep:reject error:', e); }
});

// ======== ADMIN: aprobar/rechazar RETIRO ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);

    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const car = await carteraDe(r.telegram_id);
    const totalDebitar = numero(r.monto) + RETIRO_FEE_USDT;
    if (totalDebitar > car.saldo) return ctx.answerCbQuery('Saldo insuficiente (al aprobar).');

    await actualizarCartera(r.telegram_id, { saldo: car.saldo - totalDebitar });

    await supabase.from('retiros')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log('ret:approve error:', e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);
    try { await bot.telegram.sendMessage(r.telegram_id, `❌ Tu retiro #${rid} fue RECHAZADO.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch (e) { console.log('ret:reject error:', e); }
});

// ======== /pagarhoy (MANUAL) ========
bot.command('pagarhoy', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return; // solo admin
    const { data: carteras, error } = await supabase.from('carteras')
      .select('telegram_id, saldo, principal, invertido, bruto, ganado, bonos');
    if (error) {
      console.log('Error listando carteras', error);
      return ctx.reply('Error listando carteras.');
    }

    let pagados = 0;
    for (const c of (carteras || [])) {
      const id        = c.telegram_id;
      const principal = numero(c.principal ?? c.invertido);
      const bruto     = numero(c.bruto);
      if (principal <= 0 || bruto <= 0) continue;

      // tope 500% sobre BRUTO
      const tope = tope500(bruto);

      // progreso actual (ganado + bonos)
      const ganado = numero(c.ganado);
      const bonos  = numero(c.bonos);
      const pagadoHastaAhora = ganado + bonos;

      if (pagadoHastaAhora >= tope) continue; // ya llegó al 500%

      const pct = tasaSegunBruto(bruto); // 1.5% o 2% según BRUTO
      const interes = principal * pct;

      // margen restante hasta el tope
      const margen = tope - pagadoHastaAhora;
      const pago = interes > margen ? margen : interes;

      const saldoNuevo  = numero(c.saldo) + pago;
      const ganadoNuevo = ganado + pago;

      await actualizarCartera(id, { saldo: saldoNuevo, ganado: ganadoNuevo });

      // Notificar al usuario (opcional)
      try {
        await bot.telegram.sendMessage(
          id,
          `💸 Pago diario: +${pago.toFixed(2)} USDT (tasa ${(pct*100).toFixed(2)}%)\n` +
          `Disponible: ${saldoNuevo.toFixed(2)} USDT\n` +
          `Progreso 500%: ${Math.min(100, ((ganadoNuevo + bonos) / tope) * 100).toFixed(2)}%`
        );
      } catch (eMsg) { console.log('No se pudo avisar a', id, eMsg?.message || eMsg); }

      pagados++;
    }

    await ctx.reply(`Pago diario ejecutado. Usuarios pagados: ${pagados}`);
  } catch (e) {
    console.log('Error en /pagarhoy:', e);
    try { await ctx.reply('Ocurrió un error en /pagarhoy.'); } catch {}
  }
});

// ======== Webhook / Ping ========
app.get('/', (_, res) => res.send('OK'));
app.post('/webhook', (req, res) => res.sendStatus(200));

app.listen(PORT, async () => {
  console.log(`HTTP on :${PORT} ${HOST_URL ? `(${HOST_URL})` : ''}`);
  await bot.launch();
  console.log('Bot lanzado.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
