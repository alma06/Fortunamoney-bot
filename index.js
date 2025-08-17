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
const MIN_INVERSION   = Number(process.env.MIN_INVERSION   || 25);   // USDT
const RETIRO_FEE_USDT = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE   = Number(process.env.CUP_USDT_RATE   || 400);  // 1 USDT = 400 CUP

// Payout manual /pagarhoy
const RATE_SMALL = 0.015;  // < 500 USDT de base (bruto)
const RATE_BIG   = 0.02;   // ≥ 500 USDT de base (bruto)

// Validación env
if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID) {
  console.log('Faltan variables de entorno obligatorias.');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado ========
const estado = {}; // 'INV_USDT' | 'INV_CUP' | 'RET'

// ======== Helpers ========
const menu = () => Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
const numero = (x) => Number(x || 0);

// Crear solo si NO existe (NO resetea)
async function asegurarUsuario(telegram_id) {
  const { data: u } = await supabase.from('usuarios').select('telegram_id').eq('telegram_id', telegram_id).maybeSingle();
  if (!u) await supabase.from('usuarios').insert([{ telegram_id }]);

  const { data: c } = await supabase.from('carteras').select('telegram_id').eq('telegram_id', telegram_id).maybeSingle();
  if (!c) {
    await supabase.from('carteras').insert([{ telegram_id, saldo: 0, principal: 0, invertido: 0, bruto: 0 }]);
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
  const row = {
    telegram_id,
    saldo:     (patch.saldo     !== undefined) ? patch.saldo     : cur.saldo,
    principal: (patch.principal !== undefined) ? patch.principal : cur.principal,
    invertido: (patch.principal !== undefined) ? patch.principal : cur.principal, // compat
    bruto:     (patch.bruto     !== undefined) ? patch.bruto     : cur.bruto
  };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== UI ========
bot.start(async (ctx) => {
  await asegurarUsuario(ctx.from.id);
  await ctx.reply('¡Bienvenido!', menu());
});

bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const { saldo = 0, principal = 0, bruto = 0 } = await carteraDe(chatId);
    const total = numero(saldo) + numero(principal);
    const tope  = 5 * numero(bruto);
    const progreso = bruto ? (total / tope * 100) : 0;

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${numero(principal).toFixed(2)}\n` +
      `Disponible:             ${numero(saldo).toFixed(2)}\n` +
      `Total:                  ${total.toFixed(2)}\n\n` +
      `Base para 500% (BRUTO): ${numero(bruto).toFixed(2)}\n` +
      `Tope 500%:              ${tope.toFixed(2)}\n` +
      `Progreso hacia 500%:    ${progreso.toFixed(2)}%`,
      menu()
    );
  } catch (e) {
    console.log('ERROR Saldo:', e);
    try { await ctx.reply('Error obteniendo tu saldo. Intenta de nuevo.'); } catch {}
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
  estado[ctx.from.id] = 'INV_USDT';
  await ctx.answerCbQuery();
  await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}). Solo número, ej: 50.00`);
});

bot.action('inv:cup', async (ctx) => {
  estado[ctx.from.id] = 'INV_CUP';
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
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT (además del monto solicitado).\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de Texto (montos) ========
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const txtRaw = (ctx.message?.text ?? '').trim();
    if (txtRaw.startsWith('/')) return;

    const st = estado[chatId];
    if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;

    const monto = Number(txtRaw.replace(',', '.'));
    if (isNaN(monto) || monto <= 0) {
      await ctx.reply('Monto inválido. Intenta de nuevo.');
      return;
    }

    // ---- INVERTIR ----
    if (st === 'INV_USDT' || st === 'INV_CUP') {
      if (st === 'INV_USDT' && monto < MIN_INVERSION) {
        await ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
        return;
      }
      if (st === 'INV_CUP' && monto < 500) {
        await ctx.reply('El mínimo de inversión es 500 CUP.');
        return;
      }

      await asegurarUsuario(chatId);

      const moneda = (st === 'INV_USDT') ? 'USDT' : 'CUP';
      const monto_origen = monto;
      const tasa_usdt = (st === 'INV_CUP') ? CUP_USDT_RATE : null;
      const montoFinal = (st === 'INV_CUP') ? (monto / CUP_USDT_RATE) : monto; // USDT eq.

      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: montoFinal,        // USDT equivalente
        moneda,
        monto_origen,             // lo que pagó el usuario
        tasa_usdt,
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) { await ctx.reply('Error guardando el depósito.'); return; }

      const depId = ins.data.id;
      const instrucciones = (moneda === 'USDT')
        ? `Método: USDT (BEP20)\n- Wallet: ${WALLET_USDT}`
        : `Método: CUP (Tarjeta)\n- Número de tarjeta: ${WALLET_CUP}`;

      await ctx.reply(
        `✅ Depósito creado (pendiente).\n\n` +
        `ID: ${depId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${montoFinal.toFixed(2)} USDT\n` : '') +
        `${instrucciones}\n\n` +
        `• Envía el hash (USDT) o una foto del pago (CUP).\n` +
        `• Cuando el admin confirme la recepción, tu inversión será acreditada.`,
        menu()
      );

      // Aviso al grupo admin
      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `📥 DEPÓSITO pendiente\nID: #${depId}\nUser: ${chatId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${montoFinal.toFixed(2)} USDT\n` : ''),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
              [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
            ]
          }
        }
      );

      estado[chatId] = undefined;
      return;
    }

    // ---- RETIRAR ----
    if (st === 'RET') {
      const fee = RETIRO_FEE_USDT;
      const car = await carteraDe(chatId);
      const disp = numero(car.saldo);
      const totalDebitar = monto + fee;
      if (totalDebitar > disp) {
        await ctx.reply(
          'Saldo insuficiente.\n' +
          `Disponible: ${disp.toFixed(2)} USDT\n` +
          `Se necesita: ${totalDebitar.toFixed(2)} USDT (monto + fee).`
        );
        estado[chatId] = undefined;
        return;
      }

      const insR = await supabase.from('retiros').insert([{
        telegram_id: chatId, monto, estado: 'pendiente'
      }]).select('id').single();

      if (insR.error) { await ctx.reply('No se pudo crear el retiro.'); return; }

      const retId = insR.data.id;
      await ctx.reply(
        `✅ Retiro creado (pendiente).\n\n` +
        `ID: ${retId}\n` +
        `Monto: ${monto.toFixed(2)} USDT\n` +
        `Fee descontado: ${fee.toFixed(2)} USDT`,
        menu()
      );

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

      estado[chatId] = undefined;
      return;
    }
  } catch (e) {
    console.log('Error handler texto:', e);
    try { await ctx.reply('Ocurrió un error procesando tu mensaje.'); } catch {}
  }
});

// ======== Handler de Foto (comprobante) ========
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

    if (!dep) { await ctx.reply('No encuentro un depósito pendiente.'); return; }

    await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
    await ctx.reply(`Comprobante guardado (#${dep.id}).`);

    await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
      caption: `🧾 DEPÓSITO\nID: ${dep.id}\nUser: ${uid}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Aprobar depósito',  callback_data: `dep:approve:${dep.id}` }],
          [{ text: '❌ Rechazar depósito', callback_data: `dep:reject:${dep.id}` }]
        ]
      }
    });
  } catch (e) {
    console.error('Error handler foto:', e);
  }
});

// ======== /tx <id> <hash> ========
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

    await ctx.reply('Hash agregado al depósito.');
  } catch (e) { console.log(e); }
});

// ======== ADMIN: aprobar/rechazar depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Acreditación: 90% al usuario, base 500% suma 100% del depósito
    const carPrev = await carteraDe(d.telegram_id);
    const neto = numero(d.monto) * 0.9;
    const nuevoPrincipal = numero(carPrev.principal) + neto;
    const nuevoSaldo     = numero(carPrev.saldo)     + neto;
    const nuevoBruto     = numero(carPrev.bruto)     + numero(d.monto);

    await actualizarCartera(d.telegram_id, { principal: nuevoPrincipal, saldo: nuevoSaldo, bruto: nuevoBruto });
    await supabase.from('depositos').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', depId);

    try {
      await bot.telegram.sendMessage(
        d.telegram_id,
        `✅ Depósito aprobado\n` +
        `• Monto: ${numero(d.monto).toFixed(2)} USDT\n` +
        `• Neto acreditado: ${neto.toFixed(2)} USDT\n` +
        `• Principal: ${nuevoPrincipal.toFixed(2)} USDT\n` +
        `• Disponible: ${nuevoSaldo.toFixed(2)} USDT\n` +
        `• Base 500%: ${nuevoBruto.toFixed(2)} USDT`
      );
    } catch {}

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

// ======== ADMIN: aprobar/rechazar retiro ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);

    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const totalDebitar = numero(r.monto) + RETIRO_FEE_USDT;
    const car = await carteraDe(r.telegram_id);
    if (totalDebitar > numero(car.saldo)) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: numero(car.saldo) - totalDebitar });
    await supabase.from('retiros').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', rid);

    try {
      await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT`);
    } catch {}

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log(e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);

    const { data: r } = await supabase.from('retiros').select('telegram_id').eq('id', rid).single();
    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);

    if (r?.telegram_id) {
      try { await bot.telegram.sendMessage(r.telegram_id, `❌ Tu retiro #${rid} fue RECHAZADO.`); } catch {}
    }

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch (e) { console.log(e); }
});

// ======== /pagarhoy (ADMIN) ========
// Paga mar-dom. Lunes no paga. 1.5% (<500 base) o 2% (>=500 base). Respeta tope 500%.
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const dow = new Date().getDay(); // 0 dom, 1 lun, 2 mar...
    if (dow === 1) { await ctx.reply('Hoy es lunes: no hay pago diario.'); return; }

    const { data: carteras, error } = await supabase.from('carteras')
      .select('telegram_id, saldo, principal, bruto');
    if (error) { await ctx.reply('No pude leer carteras.'); return; }

    let totalPagado = 0;
    for (const c of carteras) {
      const principal = numero(c.principal);
      const saldo     = numero(c.saldo);
      const bruto     = numero(c.bruto);
      if (bruto <= 0 || principal <= 0) continue;

      const rate = bruto >= 500 ? RATE_BIG : RATE_SMALL;
      const pago = principal * rate;

      const tope = 5 * bruto;
      const totalActual = principal + saldo;
      const margen = Math.max(0, tope - totalActual);
      const acreditado = Math.min(pago, margen);

      if (acreditado > 0) {
        await actualizarCartera(c.telegram_id, { saldo: saldo + acreditado });
        totalPagado += acreditado;
        try {
          await bot.telegram.sendMessage(
            c.telegram_id,
            `💰 Pago diario: ${acreditado.toFixed(2)} USDT\n` +
            `Tasa: ${(rate*100).toFixed(2)}% | Base: ${bruto.toFixed(2)} | Tope: ${(5*bruto).toFixed(2)}`
          );
        } catch {}
      }
    }

    await ctx.reply(`Pago manual completado. Total pagado: ${totalPagado.toFixed(2)} USDT.`);
  } catch (e) {
    console.log('ERR /pagarhoy:', e);
    await ctx.reply('Error ejecutando /pagarhoy.');
  }
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
