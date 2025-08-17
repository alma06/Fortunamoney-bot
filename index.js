// ================== FortunaMoney Bot (index completo) ==================
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
function numero(x) { return Number(x || 0) || 0; }

async function asegurarUsuario(telegram_id) {
  await supabase.from('usuarios').upsert([{ telegram_id }], { onConflict: 'telegram_id' });
  await supabase.from('carteras').upsert([{ telegram_id, saldo: 0, principal: 0 }], { onConflict: 'telegram_id' });
}

// Lee tolerando 'principal' o 'invertido'
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

// Escribe en ambas columnas para cubrir ambos esquemas
async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);
  const nuevoSaldo     = (patch.saldo     !== undefined) ? numero(patch.saldo)     : cur.saldo;
  const nuevoPrincipal = (patch.principal !== undefined) ? numero(patch.principal) : cur.principal;
  const nuevoBruto     = (patch.bruto     !== undefined) ? numero(patch.bruto)     : cur.bruto;

  const row = {
    telegram_id,
    saldo: nuevoSaldo,
    principal: nuevoPrincipal,  // por si tu esquema usa 'principal'
    invertido: nuevoPrincipal,  // por compatibilidad con esquemas viejos
    bruto: nuevoBruto
  };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== Referidos ========
async function patrocinadorDe(userId) {
  try {
    const { data } = await supabase
      .from('referidos')
      .select('patrocinador_id')
      .eq('referido_id', userId)
      .maybeSingle();
    return data?.patrocinador_id || null;
  } catch {
    return null;
  }
}

// ======== UI Básica ========
bot.start(async (ctx) => {
  await asegurarUsuario(ctx.from.id);

  // Soporte de referidos: /start ref_12345
  try {
    const text = ctx.message?.text || '';
    const partes = text.split(' ');
    if (partes.length > 1) {
      const arg = partes[1];
      if (arg.startsWith('ref_')) {
        const patroId = Number(arg.replace('ref_', ''));
        if (patroId && patroId !== ctx.from.id) {
          // Guardar referencia sólo si no existe
          const { data: ya } = await supabase.from('referidos')
            .select('id').eq('referido_id', ctx.from.id).maybeSingle();
          if (!ya) {
            await supabase.from('referidos')
              .insert([{ patrocinador_id: patroId, referido_id: ctx.from.id }]);
          }
        }
      }
    }
  } catch {}

  await ctx.reply('¡Bienvenido a FortunaMoney!', menu());
});

bot.hears('Referidos', async (ctx) => {
  const chatId = ctx.from.id;
  const enlace = `https://t.me/${ctx.botInfo?.username || 'FortunaMoneyBot'}?start=ref_${chatId}`;
  await ctx.reply(
    'Tu enlace de referido:\n' + enlace +
    '\nGanas 10% de cada inversión de tus referidos (retirable).'
  );
});

bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const { saldo = 0, principal = 0, bruto = 0 } = await carteraDe(chatId);
    const total = numero(saldo) + numero(principal);

    const tope = bruto * 5; // 500% del bruto base
    const progreso = tope > 0 ? Math.min(100, (total / tope) * 100) : 0;

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
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT (se descuenta además del monto solicitado).\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler de Texto (monto) ========
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const st = estado[chatId];
    const txt = (ctx.message?.text || '').replace(',', '.').trim();
    if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;
    if (txt.startsWith('/')) return;

    const monto = Number(txt);
    if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

    // --- Inversión ---
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

      let moneda = st === 'INV_USDT' ? 'USDT' : 'CUP';
      let monto_origen = monto;
      let tasa_usdt = null;
      let montoFinal = monto; // USDT equivalentes

      if (st === 'INV_CUP') {
        tasa_usdt = CUP_USDT_RATE;
        montoFinal = monto / tasa_usdt;
      }

      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: montoFinal,       // siempre en USDT equivalentes
        moneda,                  // 'USDT' o 'CUP'
        monto_origen,            // lo que escribió el usuario
        tasa_usdt,               // null si fue USDT
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
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${montoFinal.toFixed(2)} USDT\n` : '') +
        `${instrucciones}\n\n` +
        `• Envía el hash de la transacción (USDT) o una foto/captura del pago (CUP).\n` +
        `• Cuando el admin confirme la recepción, tu inversión será acreditada.`,
        menu()
      );

      // Aviso al admin
      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `📩 DEPÓSITO pendiente\n` +
          `ID: #${depId}\n` +
          `User: ${chatId}\n` +
          `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
          (moneda === 'CUP' ? `Equivalente: ${montoFinal.toFixed(2)} USDT\n` : ``) +
          `Usa los botones para validar.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
                [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
              ]
            }
          }
        );
      } catch (e2) { console.log('Aviso admin dep error:', e2?.message || e2); }

      estado[chatId] = undefined;
      return;
    }

    // --- Retiro ---
    if (st === 'RET') {
      const car = await carteraDe(chatId);
      const totalDebitar = monto + RETIRO_FEE_USDT;
      if (totalDebitar > car.saldo) {
        await ctx.reply(
          'Saldo insuficiente.\n' +
          `Disponible: ${car.saldo.toFixed(2)} USDT\n` +
          `Se necesita: ${totalDebitar.toFixed(2)} USDT (monto + fee).`
        );
        estado[chatId] = undefined;
        return;
      }

      const ins = await supabase.from('retiros').insert([{
        telegram_id: chatId,
        monto,
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) return ctx.reply('Error creando retiro.');
      const retId = ins.data.id;

      await ctx.reply(
        `✅ Retiro creado (pendiente).\n\n` +
        `ID: ${retId}\n` +
        `Monto: ${monto.toFixed(2)} USDT\n` +
        `Fee descontado: ${RETIRO_FEE_USDT.toFixed(2)} USDT\n\n` +
        `Si tu preferencia es CUP, el admin procesará tu pago en CUP (tasa fija).`,
        menu()
      );

      // Aviso al admin con preferencia CUP si existe
      let pref = null;
      try {
        const { data: u } = await supabase.from('usuarios')
          .select('moneda_preferida').eq('telegram_id', chatId).single();
        pref = u?.moneda_preferida || null;
      } catch {}

      const cupEq = (pref === 'CUP') ? (monto * CUP_USDT_RATE) : null;

      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `🆕 RETIRO pendiente\n` +
          `ID: #${retId}\n` +
          `User: ${chatId}\n` +
          `Monto: ${monto.toFixed(2)} USDT\n` +
          (cupEq ? `Preferencia CUP: ${cupEq.toFixed(0)} CUP\n` : ``),
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
        [{ text: '✅ Aprobar',  callback_data: `dep:approve:${dep.id}` }],
        [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}` }]
      ] }
    });
  } catch (e) { console.log('photo handler error:', e); }
});

// ======== /tx: id hash ========
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
      '🔗 Hash recibido\n' +
      `Depósito: #${depId}\n` +
      `User: ${ctx.from.id}\n` +
      `Hash: ${hash}`,
      {
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
          [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
        ] }
      }
    );

    await ctx.reply('Hash agregado al depósito.');
  } catch (e) { console.log('/tx error:', e); }
});

// ======== Aprobar/Rechazar Depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;

    const depId = Number(ctx.match[1]);
    const { data: d, error } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (error || !d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const userId = d.telegram_id;
    const montoUSDT = numero(d.monto);
    if (montoUSDT <= 0) return ctx.answerCbQuery('Monto inválido');

    // 10% al sponsor, 90% neto al inversor
    const bonoRef = +(montoUSDT * 0.10).toFixed(8);
    const neto    = +(montoUSDT - bonoRef).toFixed(8);

    const carPrev = await carteraDe(userId);
    const nuevoPrincipal = +(carPrev.principal + neto).toFixed(8);
    const nuevoSaldo     = +(carPrev.saldo + neto).toFixed(8);
    const nuevoBrutoBase = +(carPrev.bruto + montoUSDT).toFixed(8); // base 100%

    await actualizarCartera(userId, {
      principal: nuevoPrincipal,
      saldo: nuevoSaldo,
      bruto: nuevoBrutoBase
    });

    // Pagar sponsor si existe
    const patroId = await patrocinadorDe(userId);
    if (patroId) {
      await asegurarUsuario(patroId);
      const carP = await carteraDe(patroId);
      await actualizarCartera(patroId, { saldo: +(carP.saldo + bonoRef).toFixed(8) });
      try {
        await bot.telegram.sendMessage(
          patroId,
          `🎉 Bono de referido: +${bonoRef.toFixed(2)} USDT\nPor el depósito de tu referido (${userId}).`
        );
      } catch {}
    }

    // Marcar aprobado
    await supabase.from('depositos').update({
      estado: 'aprobado',
      aprobado_en: new Date().toISOString(),
      neto_acreditado: neto,
      bono_referido: bonoRef
    }).eq('id', depId);

    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ Depósito aprobado\n` +
        `• Monto: ${montoUSDT.toFixed(2)} USDT\n` +
        `• Neto acreditado: ${neto.toFixed(2)} USDT\n` +
        `• Principal: ${nuevoPrincipal.toFixed(2)} USDT\n` +
        `• Disponible: ${nuevoSaldo.toFixed(2)} USDT\n` +
        `• Base 500%: ${nuevoBrutoBase.toFixed(2)} USDT`
      );
    } catch {}

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} aprobado.`);
  } catch (e) { console.log('dep:approve error:', e); }
});

bot.action(/dep:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);
    const { data: d } = await supabase.from('depositos').select('estado, telegram_id').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
    try { await bot.telegram.sendMessage(d.telegram_id, `❌ Tu depósito #${depId} fue RECHAZADO.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} rechazado.`);
  } catch (e) { console.log('dep:reject error:', e); }
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

    await actualizarCartera(r.telegram_id, { saldo: +(car.saldo - totalDebitar).toFixed(8) });
    await supabase.from('retiros').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log('ret:approve error:', e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('telegram_id, estado').eq('id', rid).single();
    if (!r || r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);
    try { await bot.telegram.sendMessage(r.telegram_id, `❌ Tu retiro #${rid} fue RECHAZADO.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch (e) { console.log('ret:reject error:', e); }
});

// ======== /pagarhoy (manual, cap 500%) ========
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('No autorizado.');
  try {
    const { data: carteras, error } = await supabase.from('carteras').select('telegram_id, saldo, principal, bruto');
    if (error) throw error;
    if (!carteras?.length) return ctx.reply('No hay carteras.');

    let totalPagado = 0, nUsuarios = 0;

    for (const c of carteras) {
      const id        = c.telegram_id;
      const principal = numero(c.principal);
      const saldo     = numero(c.saldo);
      const brutoBase = numero(c.bruto);
      if (principal <= 0 || brutoBase <= 0) continue;

      const tasa = principal < 500 ? 0.015 : 0.02; // 1.5% o 2%
      const interes = +(principal * tasa).toFixed(8);

      const cap = brutoBase * 5;
      const pagadoHastaAhora = principal + saldo;
      if (pagadoHastaAhora >= cap) continue;

      const margen = cap - pagadoHastaAhora;
      const pago = +(Math.min(interes, margen)).toFixed(8);
      if (pago <= 0) continue;

      await actualizarCartera(id, { saldo: saldo + pago });

      try {
        await bot.telegram.sendMessage(
          id,
          `💰 Pago diario: +${pago.toFixed(2)} USDT (${(tasa*100).toFixed(1)}%)\n` +
          `Disponible: ${(saldo + pago).toFixed(2)} USDT`
        );
      } catch {}

      totalPagado += pago;
      nUsuarios++;
    }

    await ctx.reply(`✅ /pagarhoy listo\nUsuarios pagados: ${nUsuarios}\nTotal pagado: ${totalPagado.toFixed(2)} USDT`);
  } catch (e) {
    console.log('Error en /pagarhoy:', e);
    await ctx.reply('Error procesando los pagos.');
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
