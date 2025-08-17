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
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25); // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE  || 400); // 1 USDT = 400 CUP
const RATE_SMALL       = 0.015; // < 500 USDT (BRUTO)
const RATE_BIG         = 0.02;  // >= 500 USDT (BRUTO)

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID) {
  console.log('Faltan variables de entorno obligatorias.');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado en memoria ========
const estado = {}; // valores: 'INV_USDT' | 'INV_CUP' | 'RET'
const monedaInv = {}; // última moneda elegida por usuario para invertir

// ======== Helpers ========
function menu() {
  return Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
}
function numero(x){ return Number(x || 0) || 0; }
function tope500(bruto){ return 5 * numero(bruto); }

async function asegurarUsuario(telegram_id) {
  await supabase.from('usuarios').upsert([{ telegram_id }], { onConflict: 'telegram_id' });
  await supabase.from('carteras').upsert(
    [{ telegram_id, saldo: 0, principal: 0, bruto: 0, ganado: 0, ref_bonos: 0 }],
    { onConflict: 'telegram_id' }
  );
}
async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, invertido, bruto, ganado, ref_bonos')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  const saldo     = numero(data?.saldo);
  const principal = numero( (data?.principal!==undefined) ? data.principal : data?.invertido );
  const bruto     = numero(data?.bruto);
  const ganado    = numero(data?.ganado);
  const refBonos  = numero(data?.ref_bonos);

  return { saldo, principal, bruto, ganado, refBonos };
}
async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);
  const row = {
    telegram_id,
    saldo:     (patch.saldo     !== undefined) ? patch.saldo     : cur.saldo,
    principal: (patch.principal !== undefined) ? patch.principal : cur.principal,
    invertido: (patch.principal !== undefined) ? patch.principal : cur.principal, // compat antigua
    bruto:     (patch.bruto     !== undefined) ? patch.bruto     : cur.bruto,
    ganado:    (patch.ganado    !== undefined) ? patch.ganado    : cur.ganado,
    ref_bonos: (patch.ref_bonos !== undefined) ? patch.ref_bonos : cur.refBonos
  };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== Referidos ========
async function patrocinadorDe(referidoId) {
  const { data } = await supabase
    .from('referidos')
    .select('patrocinador_id')
    .eq('referido_id', referidoId)
    .maybeSingle();
  return data?.patrocinador_id || null;
}
async function registrarReferencia(patroId, referidoId) {
  if (!patroId || !referidoId || patroId === referidoId) return;
  // Si ya existe, no duplicar
  const { data } = await supabase
    .from('referidos')
    .select('id')
    .eq('referido_id', referidoId)
    .maybeSingle();
  if (!data) {
    await supabase.from('referidos').insert([{ patrocinador_id: patroId, referido_id: referidoId }]);
  }
}
async function contarReferidos(uid){
  const { data, error } = await supabase
    .from('referidos')
    .select('id', { count: 'exact', head: true })
    .eq('patrocinador_id', uid);
  return error ? 0 : (data?.length ?? 0); // count en head no retorna filas, por si acaso devolvemos 0/length
}

// Bono de referido (paga al patrocinador, acelera 500%)
async function aplicarBonoReferido(telegram_id, monto) {
  const c = await carteraDe(telegram_id);
  await actualizarCartera(telegram_id, {
    saldo:     numero(c.saldo) + numero(monto),
    ref_bonos: numero(c.refBonos) + numero(monto)
  });
}

// ======== UI Básica ========
bot.start(async (ctx) => {
  const chatId = ctx.from.id;
  await asegurarUsuario(chatId);

  // Param /start ref_123
  let payload = null;
  if (ctx.startPayload) payload = ctx.startPayload;           // Telegraf >=4
  else if (ctx.message?.text) {
    const parts = ctx.message.text.split(' ');
    if (parts[1]) payload = parts[1];
  }
  if (payload && payload.startsWith('ref_')) {
    const patroId = Number(payload.replace('ref_', ''));
    if (patroId && patroId !== chatId) await registrarReferencia(patroId, chatId);
  }

  await ctx.reply('¡Bienvenido!', menu());
});

bot.hears('Referidos', async (ctx) => {
  const chatId = ctx.from.id;
  const username = ctx.botInfo?.username || 'FortunaMoneyBot';
  const link = `https://t.me/${username}?start=ref_${chatId}`;
  const count = await contarReferidos(chatId);
  await ctx.reply(
    `Tu enlace de referido:\n${link}\n\n` +
    `Referidos activos: ${count}\n` +
    `Ganas 10% de cada inversión de tus invitados (retirable).`
  );
});

bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const { saldo=0, principal=0, bruto=0, ganado=0, refBonos=0 } = await carteraDe(chatId);
    const total = numero(saldo) + numero(principal);
    const tope  = tope500(bruto);

    // Progreso correcto: SOLO (ganado + ref_bonos)
    const progresoBase = numero(ganado) + numero(refBonos);
    const progreso = tope > 0 ? (progresoBase / tope * 100) : 0;

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${numero(principal).toFixed(2)}\n` +
      `Disponible:             ${numero(saldo).toFixed(2)}\n` +
      `Total:                  ${total.toFixed(2)}\n\n` +
      `Base para 500% (BRUTO): ${numero(bruto).toFixed(2)}\n` +
      `Tope 500%:              ${tope.toFixed(2)}\n` +
      `Ganado (acumulado):     ${numero(ganado).toFixed(2)}\n` +
      `Bonos referidos:        ${numero(refBonos).toFixed(2)}\n` +
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
  const chatId = ctx.from.id;
  estado[chatId] = 'INV_USDT';
  monedaInv[chatId] = 'USDT';
  await ctx.answerCbQuery();
  await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}). Solo número, ej: 50.00`);
});
bot.action('inv:cup', async (ctx) => {
  const chatId = ctx.from.id;
  estado[chatId] = 'INV_CUP';
  monedaInv[chatId] = 'CUP';
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

// ============== HANDLER ÚNICO DE TEXTO (montos) ==============
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const txtRaw = (ctx.message?.text ?? '').trim();
    if (txtRaw.startsWith('/')) return;

    const st = estado[chatId];
    if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;

    const txt = txtRaw.replace(',', '.');
    const monto = Number(txt);
    if (isNaN(monto) || monto <= 0) { await ctx.reply('Monto inválido.'); return; }

    // ===== INVERTIR =====
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
      const tasa_usdt = (moneda === 'CUP') ? CUP_USDT_RATE : null;
      const montoFinal = (moneda === 'CUP') ? (monto_origen / CUP_USDT_RATE) : monto_origen; // guardamos en USDT

      // Crear depósito (SIEMPRE monto en USDT)
      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: montoFinal,
        moneda,
        monto_origen,
        tasa_usdt,
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) { await ctx.reply('Error guardando depósito.'); return; }

      const depId = ins.data.id;
      const instrucciones = (moneda === 'USDT')
        ? `Método: USDT (BEP20)\nWallet: ${WALLET_USDT}`
        : `Método: CUP (Tarjeta)\nNúmero de tarjeta: ${WALLET_CUP}`;

      await ctx.reply(
        `✅ Depósito creado (pendiente).\n\n` +
        `ID: ${depId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${montoFinal.toFixed(2)} USDT\n` : ``) +
        `${instrucciones}\n\n` +
        `• Envía el hash (USDT) o una foto/captura del pago (CUP) en este chat.\n` +
        `• Cuando el admin confirme, tu inversión será acreditada.`
      );

      // Aviso admin
      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `📥 DEPÓSITO pendiente\n` +
          `ID: #${depId}\n` +
          `User: ${chatId}\n` +
          `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
          (moneda === 'CUP' ? `Equiv: ${montoFinal.toFixed(2)} USDT\n` : ``) +
          `Usa los botones para validar.`,
          {
            reply_markup: { inline_keyboard: [
              [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
              [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
            ]}
          }
        );
      } catch (e) { console.log('No pude avisar al admin (dep):', e?.message || e); }

      estado[chatId] = undefined;
      return;
    }

    // ===== RETIRAR =====
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
        `Fee descontado: ${fee.toFixed(2)} USDT`
      );

      // Aviso admin
      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `🆕 RETIRO pendiente\n` +
          `ID: #${retId}\n` +
          `Usuario: ${chatId}\n` +
          `Monto: ${monto.toFixed(2)} USDT\n` +
          `Fee: ${fee.toFixed(2)} USDT`,
          { reply_markup: { inline_keyboard: [
            [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
            [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}`  }]
          ]}}
        );
      } catch (e) { console.log('No pude avisar al admin (retiro):', e?.message || e); }

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

    if (!dep) { await ctx.reply('No encuentro un depósito pendiente.'); return; }

    await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
    await ctx.reply(`Comprobante guardado (#${dep.id}).`);

    await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
      caption: `🧾 DEPÓSITO\nID: ${dep.id}\nUser: ${uid}`,
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Aprobar', callback_data: `dep:approve:${dep.id}` }],
        [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}` }]
      ]}
    });
  } catch (e) { console.log('Error foto:', e); }
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
      `🔗 Hash recibido\nDepósito: #${depId}\nUser: ${ctx.from.id}\nHash: ${hash}`,
      { reply_markup: { inline_keyboard: [
        [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
        [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
      ] } }
    );
    await ctx.reply('Hash agregado al depósito.');
  } catch (e) { console.log(e); }
});

// ======== ADMIN: aprobar/rechazar DEPÓSITO ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Usuario dueño del depósito
    const uid = d.telegram_id;
    const montoUSDT = numero(d.monto);          // USDT equivalentes (SIEMPRE)
    const neto90    = montoUSDT * 0.90;         // pasa a principal
    const car       = await carteraDe(uid);

    // Acreditar: SOLO principal (90%) + bruto (100%)
    const nuevoPrincipal = numero(car.principal) + neto90;
    const nuevoBruto     = numero(car.bruto) + montoUSDT;

    await actualizarCartera(uid, { principal: nuevoPrincipal, bruto: nuevoBruto });
    await supabase.from('depositos').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', depId);

    // Bono 10% al patrocinador (retirable y acelera 500%)
    const patroId = await patrocinadorDe(uid);
    if (patroId) {
      const bono = montoUSDT * 0.10;
      await aplicarBonoReferido(patroId, bono);
      try {
        await bot.telegram.sendMessage(patroId, `🎁 Bono de referido: +${bono.toFixed(2)} USDT (por depósito de ${uid}).`);
      } catch {}
    }

    // Aviso al usuario
    try {
      await bot.telegram.sendMessage(
        uid,
        `✅ Depósito aprobado: ${montoUSDT.toFixed(2)} USDT\n` +
        `A tu principal se acreditó: ${neto90.toFixed(2)} USDT\n` +
        `BRUTO base actualizado: ${nuevoBruto.toFixed(2)} USDT`
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

// ======== ADMIN: aprobar/rechazar RETIRO ========
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
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch (e) { console.log(e); }
});

// ======== /pagarhoy (manual) ========
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const dow = new Date().getDay(); // 0 dom, 1 lun, 2 mar...
    if (dow === 1) { await ctx.reply('Hoy es lunes: no hay pago diario.'); return; }

    const { data: carteras, error } = await supabase
      .from('carteras')
      .select('telegram_id, saldo, principal, bruto, ganado, ref_bonos');
    if (error) { await ctx.reply('No pude leer carteras.'); return; }

    let totalPagado = 0, pagados = 0;

    for (const c of (carteras || [])) {
      const principal = numero(c.principal);
      const saldo     = numero(c.saldo);
      const bruto     = numero(c.bruto);
      const ganado    = numero(c.ganado);
      const refBonos  = numero(c.ref_bonos);

      if (bruto <= 0 || principal <= 0) continue;

      const rate = bruto >= 500 ? RATE_BIG : RATE_SMALL;
      const pago = principal * rate;

      const tope    = tope500(bruto);
      const margen  = Math.max(0, tope - (ganado + refBonos));
      const abonar  = Math.min(pago, margen);
      if (abonar <= 0) continue;

      await actualizarCartera(c.telegram_id, {
        saldo:  saldo + abonar,
        ganado: ganado + abonar
      });

      totalPagado += abonar;
      pagados++;

      try {
        await bot.telegram.sendMessage(
          c.telegram_id,
          `💰 Pago diario: ${abonar.toFixed(2)} USDT\n` +
          `Tasa: ${(rate*100).toFixed(2)}%\n` +
          `Base (BRUTO): ${bruto.toFixed(2)} | Tope: ${tope.toFixed(2)}`
        );
      } catch {}
    }

    await ctx.reply(`Pago manual completado. Usuarios pagados: ${pagados}. Total: ${totalPagado.toFixed(2)} USDT.`);
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
