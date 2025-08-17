// ================== FortunaMoney Bot (Render + Webhook) ==================
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
const HOST_URL       = process.env.HOST_URL || ''; // https://tu-servicio.onrender.com
const PORT           = Number(process.env.PORT || 3000);

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
const numero = (x) => Number(x || 0) || 0;

function tasaSegunBruto(brutoTotal) { return brutoTotal >= 500 ? 0.02 : 0.015; }
function brutoDesdeNeto(neto) { return neto > 0 ? (neto / 0.9) : 0; }
function tope500Bruto(bruto) { return bruto * 5.0; }

async function asegurarUsuario(telegram_id) {
  await supabase.from('usuarios').upsert([{ telegram_id }], { onConflict: 'telegram_id' });
  await supabase.from('carteras').upsert(
    [{ telegram_id, saldo: 0, principal: 0, bruto: 0 }],
    { onConflict: 'telegram_id' }
  );
}

async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, invertido, bruto')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  const principal = numero(data?.principal !== undefined ? data.principal : data?.invertido);
  return {
    saldo: numero(data?.saldo),
    principal,
    bruto: numero(data?.bruto)
  };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);
  const upd = {
    saldo:     patch.saldo     !== undefined ? patch.saldo     : cur.saldo,
    principal: patch.principal !== undefined ? patch.principal : cur.principal,
    bruto:     patch.bruto     !== undefined ? patch.bruto     : cur.bruto
  };
  const row = { telegram_id, saldo: upd.saldo, principal: upd.principal, invertido: upd.principal, bruto: upd.bruto };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// Patrocinio
async function patrocinadorDe(userId) {
  const { data, error } = await supabase
    .from('referidos')
    .select('patrocinador_id')
    .eq('referido_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data.patrocinador_id;
}
async function registrarReferencia(patroId, referidoId) {
  if (!patroId || !referidoId || patroId === referidoId) return;
  const { data } = await supabase.from('referidos')
    .select('id').eq('referido_id', referidoId).maybeSingle();
  if (!data) await supabase.from('referidos').insert([{ patrocinador_id: patroId, referido_id: referidoId }]);
}
async function totalRetirado(id) {
  const { data } = await supabase.from('retiros')
    .select('monto').eq('telegram_id', id).eq('estado', 'aprobado');
  let s = 0; (data || []).forEach(r => s += numero(r.monto));
  return s;
}

// Para enlaces de referidos
let BOT_USERNAME = null;
(async () => {
  try { const me = await bot.telegram.getMe(); BOT_USERNAME = me.username; } catch {}
})();

// ======== Bot: /start con ref_ ========
bot.start(async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const text = ctx.message.text || '';
    const partes = text.split(' ');
    if (partes.length > 1 && partes[1].startsWith('ref_')) {
      const patroId = Number(partes[1].replace('ref_', ''));
      if (patroId && patroId !== chatId) await registrarReferencia(patroId, chatId);
    }

    await ctx.reply('¡Bienvenido! Usa el menú:', menu());
  } catch (e) {
    console.log('Error en /start:', e);
    try { await ctx.reply('Ocurrió un error al iniciar.'); } catch {}
  }
});

// ======== Saldo ========
bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    const car = await carteraDe(chatId);
    const bruto = car.bruto || brutoDesdeNeto(car.principal);
    if (!car.bruto) await actualizarCartera(chatId, { bruto });
    const total = numero(car.saldo) + numero(car.principal);
    const progreso = bruto ? Math.min(100, ( (car.saldo + await totalRetirado(chatId)) / tope500Bruto(bruto) ) * 100) : 0;

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${car.principal.toFixed(2)}\n` +
      `Disponible:             ${car.saldo.toFixed(2)}\n` +
      `Total:                  ${total.toFixed(2)}\n\n` +
      `Bruto (base para 500%): ${bruto.toFixed(2)}\n` +
      `Progreso hacia 500%:    ${progreso.toFixed(2)}%`,
      menu()
    );
  } catch (e) {
    console.log('ERROR Saldo:', e);
    try { await ctx.reply('Error obteniendo tu saldo.'); } catch {}
  }
});

// ======== Referidos ========
bot.hears('Referidos', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    const username = BOT_USERNAME || (await bot.telegram.getMe()).username || 'FortunaMoneyBot';
    const enlace = `https://t.me/${username}?start=ref_${chatId}`;
    await ctx.reply(
      'Tu enlace de referido:\n' + enlace +
      '\nGanas 10% de cada inversión de tu referido (retirable).'
    );
  } catch (e) { console.log('Referidos error:', e); }
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
    `Tu saldo disponible es: ${car.saldo.toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT (se descuenta además del monto solicitado)\n` +
    'Escribe el monto a retirar (solo número, ej: 25.00)'
  );
});

// ======== Handler Único de Texto (monto) ========
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const st = estado[chatId];
    const txt = (ctx.message?.text ?? '').trim().replace(',', '.');
    if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;
    const monto = Number(txt);
    if (isNaN(monto) || monto <= 0) return ctx.reply('Monto inválido.');

    // --- INVERTIR ---
    if (st === 'INV_USDT' || st === 'INV_CUP') {
      if (st === 'INV_USDT' && monto < MIN_INVERSION) return ctx.reply(`El mínimo es ${MIN_INVERSION} USDT.`);
      if (st === 'INV_CUP'  && monto < 500)          return ctx.reply('El mínimo es 500 CUP.');

      await asegurarUsuario(chatId);

      const moneda = (st === 'INV_USDT') ? 'USDT' : 'CUP';
      const monto_origen = monto;
      const tasa_usdt = (moneda === 'CUP') ? CUP_USDT_RATE : null;
      const monto_usdt = (moneda === 'CUP') ? (monto_origen / CUP_USDT_RATE) : monto_origen;

      // Guardar depósito
      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: numero(monto_usdt),
        moneda,
        monto_origen: numero(monto_origen),
        tasa_usdt,
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) {
        console.log('Error insert depósito:', ins.error);
        return ctx.reply('Error guardando el depósito.');
      }

      const depId = ins.data.id;
      const instrucciones = (moneda === 'USDT')
        ? `Método: USDT (BEP20)\nWallet: ${WALLET_USDT}`
        : `Método: CUP (Tarjeta)\nNúmero de tarjeta: ${WALLET_CUP}`;

      await ctx.reply(
        `✅ Depósito creado (pendiente).\n\n` +
        `ID: ${depId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${monto_usdt.toFixed(2)} USDT\n` : '') +
        `${instrucciones}\n\n` +
        `• Envía el hash (USDT) o foto/captura (CUP) aquí.\n` +
        `• Cuando el admin confirme, tu inversión será acreditada.`,
        menu()
      );

      // Aviso admin
      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `📩 DEPÓSITO pendiente\n` +
        `ID: #${depId}\n` +
        `User: ${chatId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Eq: ${monto_usdt.toFixed(2)} USDT\n` : ''),
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

    // --- RETIRAR ---
    if (st === 'RET') {
      const car = await carteraDe(chatId);
      const totalDebitar = monto + RETIRO_FEE_USDT;
      if (totalDebitar > car.saldo) return ctx.reply('Saldo insuficiente.');

      const insR = await supabase.from('retiros').insert([{
        telegram_id: chatId,
        monto: numero(monto),
        estado: 'pendiente'
      }]).select('id').single();

      if (insR.error) return ctx.reply('No se pudo crear el retiro.');
      const rid = insR.data.id;

      await ctx.reply(
        `✅ Retiro creado (pendiente).\n\n` +
        `ID: ${rid}\n` +
        `Monto: ${monto.toFixed(2)} USDT\n` +
        `Fee: ${RETIRO_FEE_USDT.toFixed(2)} USDT`,
        menu()
      );

      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `🆕 RETIRO pendiente\n` +
        `ID: #${rid}\n` +
        `User: ${chatId}\n` +
        `Monto: ${monto.toFixed(2)} USDT`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${rid}` }],
              [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${rid}`  }]
            ]
          }
        }
      );

      estado[chatId] = undefined;
      return;
    }
  } catch (e) {
    console.log('Error en handler de texto:', e);
    try { await ctx.reply('Ocurrió un error procesando tu mensaje.'); } catch {}
  }
});

// ======== Foto (comprobante) ========
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
    await ctx.reply(`Comprobante guardado para el depósito #${dep.id}.`);

    await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
      caption: `🧾 DEPÓSITO\nID: #${dep.id}\nUser: ${uid}`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Aprobar',  callback_data: `dep:approve:${dep.id}` }],
          [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}` }]
        ]
      }
    });
  } catch (e) { console.log('photo err:', e); }
});

// ======== /tx (hash) ========
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
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
        [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
      ]}}
    );
  } catch (e) { console.log('/tx err:', e); }
});

// ======== ADMIN: aprobar/rechazar DEPÓSITO ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase
      .from('depositos')
      .select('*')
      .eq('id', depId)
      .single();

    if (!d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // 1) neto 90% -> principal
    const netoUser = numero(d.monto) * 0.90;

    const carU = await carteraDe(d.telegram_id);
    const nuevoPrincipal = numero(carU.principal) + netoUser;
    const nuevoBruto = brutoDesdeNeto(nuevoPrincipal);

    await actualizarCartera(d.telegram_id, {
      principal: nuevoPrincipal,
      bruto: nuevoBruto
    });

    // 2) bono 10% -> saldo del patrocinador
    const patroId = await patrocinadorDe(d.telegram_id);
    if (patroId) {
      await asegurarUsuario(patroId);
      const carP = await carteraDe(patroId);
      const bono = numero(d.monto) * 0.10;
      await actualizarCartera(patroId, { saldo: numero(carP.saldo) + bono });

      try {
        await bot.telegram.sendMessage(
          patroId,
          `🎉 Bono de referido (10%) acreditado: ${bono.toFixed(2)} USDT\nPor el depósito de tu referido.`
        );
      } catch (e) { console.log('Aviso patro err:', e?.message || e); }
    }

    await supabase.from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    try {
      await bot.telegram.sendMessage(
        d.telegram_id,
        `✅ Depósito aprobado: ${numero(d.monto).toFixed(2)} USDT.\n` +
        `Principal acreditado (90%): ${netoUser.toFixed(2)} USDT.\n` +
        `Bruto (base 500%): ${nuevoBruto.toFixed(2)} USDT.`
      );
    } catch (e) { console.log('Aviso user err:', e?.message || e); }

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} aprobado.`);
  } catch (e) { console.log('dep:approve err:', e); }
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
  } catch (e) { console.log('dep:reject err:', e); }
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
    if (totalDebitar > numero(car.saldo)) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: numero(car.saldo) - totalDebitar });

    await supabase.from('retiros')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log('ret:approve err:', e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);

    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Devolver saldo: SOLO el monto (fee queda consumido)
    const car = await carteraDe(r.telegram_id);
    await actualizarCartera(r.telegram_id, { saldo: numero(car.saldo) + numero(r.monto) });

    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `❌ Retiro rechazado. Monto devuelto a tu saldo.`); } catch {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado y monto devuelto.`);
  } catch (e) { console.log('ret:reject err:', e); }
});

// ======== /pagarhoy (manual, admin) ========
bot.command('pagarhoy', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return;

    const { data: carteras, error } = await supabase
      .from('carteras')
      .select('telegram_id, saldo, principal, invertido, bruto');

    if (error || !carteras) {
      console.log('Error listando carteras', error);
      return ctx.reply('Error listando carteras.');
    }

    let pagados = 0;
    for (const c of carteras) {
      const uid = c.telegram_id;
      const principal = numero(c.principal !== null ? c.principal : c.invertido);
      let saldo = numero(c.saldo);
      if (principal <= 0) continue;

      let brutoTotal = numero(c.bruto);
      if (!brutoTotal) brutoTotal = brutoDesdeNeto(principal);

      const pct = tasaSegunBruto(brutoTotal);
      const interes = principal * pct;

      const retirado = await totalRetirado(uid);
      const pagadoHastaAhora = saldo + retirado;
      const tope = tope500Bruto(brutoTotal);

      if (pagadoHastaAhora >= tope) continue;

      const margen = tope - pagadoHastaAhora;
      const pago = interes > margen ? margen : interes;
      const nuevoSaldo = saldo + pago;

      await actualizarCartera(uid, { saldo: nuevoSaldo, bruto: brutoTotal });

      try {
        await bot.telegram.sendMessage(
          uid,
          `💸 Pago diario acreditado: ${pago.toFixed(2)} USDT (tasa ${(pct*100).toFixed(2)}%).\n` +
          `Disponible: ${nuevoSaldo.toFixed(2)} USDT.`
        );
      } catch (e) { console.log('No se pudo avisar a', uid, e?.message || e); }

      pagados++;
    }

    await ctx.reply(`Pago diario ejecutado. Usuarios pagados: ${pagados}`);
  } catch (e) {
    console.log('Error en /pagarhoy:', e);
    try { await ctx.reply('Error en el pago diario.'); } catch {}
  }
});

// ======== HTTP + WEBHOOK ========
app.get('/', (_req, res) => res.send('OK'));
app.get('/health', (_req, res) => res.send('OK'));

// webhook path único por bot
const webhookPath = `/webhook/${BOT_TOKEN}`;

// Ping simple
app.get(webhookPath, (_req, res) => res.status(200).send('OK'));

// Handler real del webhook
app.post(webhookPath, (req, res) => {
  try { console.log('>> Update recibido:', JSON.stringify(req.body)); } catch {}
  return bot.webhookCallback(webhookPath)(req, res);
});

// ======== Arranque ========
app.listen(PORT, async () => {
  console.log(`HTTP on :${PORT} ${HOST_URL ? `(${HOST_URL})` : ''}`);
  try {
    if (!HOST_URL) {
      console.log('HOST_URL vacío. Debe apuntar a tu URL pública (https) de Render.');
    } else {
      const url = `${HOST_URL}${webhookPath}`;
      await bot.telegram.setWebhook(url);
      console.log('Webhook configurado en:', url);
    }
  } catch (e) {
    console.log('Error configurando webhook:', e?.message || e);
  }
});

// Paradas limpias
process.once('SIGINT', async () => { try { await bot.telegram.deleteWebhook(); } catch {} process.exit(0); });
process.once('SIGTERM', async () => { try { await bot.telegram.deleteWebhook(); } catch {} process.exit(0); });
