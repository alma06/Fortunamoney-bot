// ================== FortunaMoney Bot (Render Webhook, depósitos USDT/CUP) ==================
require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ======== ENV ========
const BOT_TOKEN      = process.env.BOT_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const ADMIN_ID       = Number(process.env.ADMIN_ID || 0);
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID || 0);
const HOST_URL       = process.env.HOST_URL || '';
const PORT           = Number(process.env.PORT || 3000);

// Reglas / parámetros
const WALLET_USDT     = process.env.WALLET_USDT || 'WALLET_NO_CONFIGURADA';
const WALLET_CUP      = process.env.WALLET_CUP  || 'TARJETA_NO_CONFIGURADA';
const MIN_INVERSION   = Number(process.env.MIN_INVERSION || 25);  // USDT
const RETIRO_FEE_USDT = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE   = Number(process.env.CUP_USDT_RATE || 400); // 1 USDT = 400 CUP

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID || !HOST_URL) {
  console.log('Faltan variables: BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, ADMIN_ID, ADMIN_GROUP_ID, HOST_URL');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado en memoria (paso actual del usuario) ========
const estado = {}; // { [telegram_id]: 'INV_USDT' | 'INV_CUP' | 'RET' }

// ======== Helpers UI ========
function menu() {
  return Markup.keyboard([
    ['Invertir'],
    ['Retirar'],
    ['Saldo'],
    ['Referidos']
  ]).resize();
}
function numero(x) { return Number(x || 0) || 0; }

// ======== BD Helpers ========
async function asegurarUsuario(telegram_id, ref_by = null) {
  // usuarios: guarda ref_by solo si no existía
  try {
    const { data: u } = await supabase.from('usuarios')
      .select('telegram_id, ref_by').eq('telegram_id', telegram_id).maybeSingle();
    if (!u) {
      await supabase.from('usuarios').insert([{ telegram_id, ref_by }]);
    } else if (!u.ref_by && ref_by && ref_by !== telegram_id) {
      await supabase.from('usuarios').update({ ref_by }).eq('telegram_id', telegram_id);
    }
  } catch (_) {}

  // carteras: crear si no existe, sin pisar saldos
  try {
    const { data: c } = await supabase.from('carteras')
      .select('telegram_id').eq('telegram_id', telegram_id).maybeSingle();
    if (!c) {
      await supabase.from('carteras').insert([{
        telegram_id,
        saldo: 0,
        principal: 0,  // invertido neto
        bruto: 0,      // base para 500%
        ganado: 0,     // acumulado de pagos diarios
        referidos: 0   // acumulado de bonos de referido
      }]);
    }
  } catch (_) {}
}

async function carteraDe(telegram_id) {
  const { data } = await supabase.from('carteras')
    .select('saldo, principal, invertido, bruto, ganado, referidos')
    .eq('telegram_id', telegram_id).maybeSingle();

  const saldo   = numero(data?.saldo);
  const prinRaw = (data?.principal !== undefined ? data.principal : data?.invertido);
  const principal = numero(prinRaw);
  const bruto  = numero(data?.bruto);
  const ganado = numero(data?.ganado);
  const referidos = numero(data?.referidos);
  return { saldo, principal, bruto, ganado, referidos };
}

async function actualizarCartera(telegram_id, patch) {
  const cur = await carteraDe(telegram_id);
  const row = {
    telegram_id,
    saldo:     (patch.saldo     !== undefined) ? numero(patch.saldo)     : cur.saldo,
    principal: (patch.principal !== undefined) ? numero(patch.principal) : cur.principal,
    invertido: (patch.principal !== undefined) ? numero(patch.principal) : cur.principal, // compat
    bruto:     (patch.bruto     !== undefined) ? numero(patch.bruto)     : cur.bruto,
    ganado:    (patch.ganado    !== undefined) ? numero(patch.ganado)    : cur.ganado,
    referidos: (patch.referidos !== undefined) ? numero(patch.referidos) : cur.referidos
  };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

async function totalRetirado(telegram_id) {
  const { data } = await supabase.from('retiros')
    .select('monto').eq('telegram_id', telegram_id).eq('estado', 'aprobado');
  return (data || []).reduce((s, r) => s + numero(r.monto), 0);
}

// ======== Finanzas ========
function tasaSegunBruto(brutoTotal) {
  return brutoTotal >= 500 ? 0.02 : 0.015;
}
function tope500Bruto(bruto) { return bruto * 5.0; } // 500%

// ================== START + Básicos ==================
bot.start(async (ctx) => {
  try {
    // /start ref_12345
    const payload = ctx.startPayload || '';
    let ref_by = null;
    if (payload.startsWith('ref_')) {
      const id = Number(payload.replace('ref_', ''));
      if (id && id !== ctx.from.id) ref_by = id;
    }
    await asegurarUsuario(ctx.from.id, ref_by);
    await ctx.reply('👋 Bienvenido a FortunaMoney. Usa el menú:', menu());
  } catch (e) { console.log('START error:', e); }
});

bot.hears('Referidos', async (ctx) => {
  try {
    const enlace = `https://t.me/${ctx.botInfo.username}?start=ref_${ctx.from.id}`;
    await ctx.reply(
      `Tu enlace de referido:\n${enlace}\n\n` +
      `Ganas 10% de cada inversión de tu referido (se acredita a tu saldo disponible).`
    );
  } catch (e) { console.log('Referidos error:', e); }
});

bot.hears('Saldo', async (ctx) => {
  try {
    const uid = ctx.from.id;
    await asegurarUsuario(uid);
    const car = await carteraDe(uid);
    const retirado = await totalRetirado(uid);

    const pagadoHastaAhora = car.saldo + retirado;    // solo ganancias & bonos ya generados
    const tope = tope500Bruto(car.bruto);
    const progreso = tope > 0 ? Math.min(100, (pagadoHastaAhora / tope) * 100) : 0;

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${car.principal.toFixed(2)}\n` +
      `Disponible:             ${car.saldo.toFixed(2)}\n` +
      `Total:                  ${(car.principal + car.saldo).toFixed(2)}\n\n` +
      `Base para 500% (BRUTO): ${car.bruto.toFixed(2)}\n` +
      `Acumulado (ganado):     ${car.ganado.toFixed(2)}\n` +
      `Bonos referidos:        ${car.referidos.toFixed(2)}\n` +
      `Retirado:               ${retirado.toFixed(2)}\n` +
      `Progreso hacia 500%:    ${progreso.toFixed(2)}%`,
      menu()
    );
  } catch (e) { console.log('Saldo error:', e); }
});

// ================== Invertir ==================
bot.hears('Invertir', async (ctx) => {
  try {
    await ctx.reply('Elige método de inversión:', Markup.inlineKeyboard([
      [{ text: 'USDT (BEP20)', callback_data: 'inv:usdt' }],
      [{ text: 'CUP (Tarjeta)', callback_data: 'inv:cup' }],
    ]));
  } catch (e) { console.log('Invertir error:', e); }
});

bot.action('inv:usdt', async (ctx) => {
  try {
    estado[ctx.from.id] = 'INV_USDT';
    await ctx.answerCbQuery();
    await ctx.reply(`Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}). Solo número, ej: 50.00`);
  } catch (e) { console.log(e); }
});

bot.action('inv:cup', async (ctx) => {
  try {
    estado[ctx.from.id] = 'INV_CUP';
    await ctx.answerCbQuery();
    await ctx.reply('Escribe el monto a invertir en CUP (mínimo 500). Solo número, ej: 20000');
  } catch (e) { console.log(e); }
});

// ================== Retirar ==================
bot.hears('Retirar', async (ctx) => {
  try {
    const uid = ctx.from.id;
    await asegurarUsuario(uid);
    const car = await carteraDe(uid);
    estado[uid] = 'RET';
    await ctx.reply(
      `Tu saldo disponible es: ${car.saldo.toFixed(2)} USDT\n` +
      `Fee de retiro: ${RETIRO_FEE_USDT} USDT (se descuenta además del monto solicitado).\n` +
      'Escribe el monto a retirar (solo número, ej: 25.00)'
    );
  } catch (e) { console.log(e); }
});

// ================== Handler único de TEXTO (montos) ==================
bot.on('text', async (ctx) => {
  try {
    const uid = ctx.from.id;
    const st = estado[uid];
    const raw = (ctx.message?.text || '').trim();
    if (!st || raw.startsWith('/')) return;

    // normaliza número
    const n = Number(raw.replace(',', '.'));
    if (isNaN(n) || n <= 0) {
      await ctx.reply('Monto inválido. Intenta de nuevo.');
      return;
    }

    // --- INVERTIR ---
    if (st === 'INV_USDT' || st === 'INV_CUP') {
      if (st === 'INV_USDT' && n < MIN_INVERSION) {
        await ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
        return;
      }
      if (st === 'INV_CUP' && n < 500) {
        await ctx.reply('El mínimo de inversión es 500 CUP.');
        return;
      }

      await asegurarUsuario(uid);

      const moneda = (st === 'INV_USDT') ? 'USDT' : 'CUP';
      const monto_origen = n;
      const tasa_usdt = (moneda === 'CUP') ? CUP_USDT_RATE : null;
      const monto = (moneda === 'CUP') ? (monto_origen / CUP_USDT_RATE) : monto_origen; // guardar equivalente en USDT

      const ins = await supabase.from('depositos').insert([{
        telegram_id: uid,
        monto,              // USDT equivalentes
        moneda,             // 'USDT' | 'CUP'
        monto_origen,       // lo que escribió el user
        tasa_usdt,          // null si USDT
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) { await ctx.reply('Error guardando el depósito. Intenta nuevamente.'); return; }
      const depId = ins.data.id;

      const instrucciones = (moneda === 'USDT')
        ? `• Método: USDT (BEP20)\n• Wallet: ${WALLET_USDT}`
        : `• Método: CUP (Tarjeta)\n• Número de tarjeta: ${WALLET_CUP}`;

      await ctx.reply(
        `✅ Depósito creado (pendiente).\n\n` +
        `ID: ${depId}\n` +
        `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
        (moneda === 'CUP' ? `Equivalente: ${monto.toFixed(2)} USDT\n` : '') +
        `${instrucciones}\n\n` +
        `• Envía el hash (USDT) o una foto/captura del pago (CUP).\n` +
        `• Cuando el admin confirme, tu inversión será acreditada.`,
        menu()
      );

      // Aviso al grupo admin
      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `📥 DEPÓSITO pendiente\n` +
          `ID: #${depId}\n` +
          `User: ${uid}\n` +
          `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
          (moneda === 'CUP' ? `Equivalente: ${monto.toFixed(2)} USDT\n` : '') +
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
      } catch (e2) { console.log('Aviso admin depósito error:', e2); }

      estado[uid] = undefined;
      return;
    }

    // --- RETIRAR ---
    if (st === 'RET') {
      await asegurarUsuario(uid);
      const car = await carteraDe(uid);
      const totalDebitar = n + RETIRO_FEE_USDT;
      if (totalDebitar > car.saldo) {
        await ctx.reply(
          'Saldo insuficiente.\n' +
          `Disponible: ${car.saldo.toFixed(2)} USDT\n` +
          `Se necesita: ${totalDebitar.toFixed(2)} USDT (monto + fee).`
        );
        estado[uid] = undefined;
        return;
      }

      const insR = await supabase.from('retiros').insert([{
        telegram_id: uid,
        monto: n,
        estado: 'pendiente'
      }]).select('id').single();

      if (insR.error) { await ctx.reply('No se pudo crear el retiro.'); return; }
      const retId = insR.data.id;

      await ctx.reply(
        `✅ Retiro creado (pendiente).\n\n` +
        `ID: ${retId}\n` +
        `Monto: ${n.toFixed(2)} USDT\n` +
        `Fee: ${RETIRO_FEE_USDT.toFixed(2)} USDT`,
        menu()
      );

      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `🆕 RETIRO pendiente\n` +
          `ID: #${retId}\n` +
          `User: ${uid}\n` +
          `Monto: ${n.toFixed(2)} USDT\n` +
          `Fee: ${RETIRO_FEE_USDT.toFixed(2)} USDT`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
                [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}`  }]
              ]
            }
          }
        );
      } catch (e2) { console.log('Aviso admin retiro error:', e2); }

      estado[uid] = undefined;
      return;
    }

  } catch (e) {
    console.log('Handler texto error:', e);
    try { await ctx.reply('Ocurrió un error procesando tu mensaje.'); } catch {}
  }
});

// ================== Foto (comprobante) ==================
bot.on('photo', async (ctx) => {
  try {
    const uid = ctx.from.id;
    const photos = ctx.message.photo || [];
    if (!photos.length) return;
    const best = photos[photos.length - 1];
    const fileId = best.file_id;

    const { data: dep } = await supabase.from('depositos')
      .select('id, estado').eq('telegram_id', uid).eq('estado', 'pendiente')
      .order('id', { ascending: false }).limit(1).maybeSingle();
    if (!dep) { await ctx.reply('No encuentro depósito pendiente.'); return; }

    await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
    await ctx.reply(`Comprobante guardado (#${dep.id}).`);

    try {
      await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, {
        caption: `🧾 Comprobante de DEPÓSITO\nID: ${dep.id}\nUser: ${uid}`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Aprobar',  callback_data: `dep:approve:${dep.id}` }],
            [{ text: '❌ Rechazar', callback_data: `dep:reject:${dep.id}`  }]
          ]
        }
      });
    } catch (e2) { console.log('Foto al admin error:', e2); }
  } catch (e) { console.log('Handler foto error:', e); }
});

// ================== /tx <id> <hash> ==================
bot.command('tx', async (ctx) => {
  try {
    const parts = (ctx.message.text || '').trim().split(/\s+/);
    if (parts.length < 3) return ctx.reply('Uso: /tx <id_deposito> <hash>');
    const depId = Number(parts[1]);
    const hash = parts.slice(2).join(' ');

    const { data: dep } = await supabase.from('depositos')
      .select('id, telegram_id, estado').eq('id', depId).maybeSingle();
    if (!dep || dep.telegram_id !== ctx.from.id) return ctx.reply('Depósito no encontrado.');
    if (dep.estado !== 'pendiente') return ctx.reply('Ese depósito ya no está pendiente.');

    await supabase.from('depositos').update({ tx: hash }).eq('id', depId);

    await ctx.reply('Hash agregado al depósito.');
    try {
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
    } catch (e2) { console.log('Aviso hash admin error:', e2); }
  } catch (e) { console.log('tx error:', e); }
});

// ================== ADMIN: Depósitos ==================
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Acreditar (90% al principal, 10% al sponsor como bono retirable)
    const userId = d.telegram_id;
    const montoBruto = numero(d.monto); // en USDT equivalentes
    const netoPrincipal = montoBruto * 0.90;
    const bonoSponsor   = montoBruto * 0.10;

    // Actualiza cartera del inversor: aumenta principal y BRUTO (base 500%)
    const carU = await carteraDe(userId);
    await actualizarCartera(userId, {
      principal: carU.principal + netoPrincipal,
      bruto:     carU.bruto + montoBruto
      // saldo NO se toca aquí
    });

    // Bono de referido (si tiene sponsor)
    try {
      const { data: usr } = await supabase.from('usuarios')
        .select('ref_by').eq('telegram_id', userId).maybeSingle();
      const sponsorId = usr?.ref_by ? Number(usr.ref_by) : null;

      if (sponsorId && sponsorId !== userId) {
        const carS = await carteraDe(sponsorId);
        await actualizarCartera(sponsorId, {
          saldo:     carS.saldo + bonoSponsor,
          referidos: carS.referidos + bonoSponsor
        });
        try {
          await bot.telegram.sendMessage(sponsorId,
            `🎉 Bono de referido: ${bonoSponsor.toFixed(2)} USDT\n` +
            `Por el depósito de tu referido. Ya está disponible para retirar.`
          );
        } catch (_) {}
      }
    } catch (e2) { console.log('Pago sponsor error:', e2); }

    await supabase.from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    try {
      await bot.telegram.sendMessage(
        userId,
        `✅ Depósito aprobado: ${montoBruto.toFixed(2)} USDT\n` +
        `A tu principal se acreditó: ${netoPrincipal.toFixed(2)} USDT\n` +
        `Base 500% (BRUTO) total: ${(carU.bruto + montoBruto).toFixed(2)} USDT`
      );
    } catch (_) {}

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
    try { await bot.telegram.sendMessage(d.telegram_id, `❌ Tu depósito #${depId} fue RECHAZADO.`); } catch (_) {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} rechazado.`);
  } catch (e) { console.log('dep:reject error:', e); }
});

// ================== ADMIN: Retiros ==================
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const car = await carteraDe(r.telegram_id);
    const totalDebitar = numero(r.monto) + RETIRO_FEE_USDT;
    if (totalDebitar > car.saldo) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: car.saldo - totalDebitar });

    await supabase.from('retiros')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${numero(r.monto).toFixed(2)} USDT`); } catch (_) {}
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

    // devolver monto (sin fee), opcional:
    const car = await carteraDe(r.telegram_id);
    await actualizarCartera(r.telegram_id, { saldo: car.saldo + numero(r.monto) });

    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);

    try { await bot.telegram.sendMessage(r.telegram_id, `❌ Retiro rechazado. Monto devuelto al saldo.`); } catch (_) {}
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado y monto devuelto.`);
  } catch (e) { console.log('ret:reject error:', e); }
});

// ================== ADMIN: /pagarhoy (manual) ==================
bot.command('pagarhoy', async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID) return;

    const { data: carteras } = await supabase.from('carteras')
      .select('telegram_id, saldo, principal, bruto');
    if (!carteras || carteras.length === 0) return ctx.reply('No hay carteras.');

    let pagados = 0;
    for (const c of carteras) {
      const id = c.telegram_id;
      const principal = numero(c.principal);
      const saldo = numero(c.saldo);
      const bruto = numero(c.bruto);

      if (principal <= 0 || bruto <= 0) continue;

      const pct = tasaSegunBruto(bruto);
      const interes = principal * pct;

      const retirado = await totalRetirado(id);
      const pagadoHastaAhora = saldo + retirado;
      const tope = tope500Bruto(bruto);
      if (pagadoHastaAhora >= tope) continue;

      const margen = tope - pagadoHastaAhora;
      const pago = Math.max(0, Math.min(interes, margen));
      if (pago <= 0) continue;

      await actualizarCartera(id, {
        saldo: saldo + pago,
        ganado: numero(c.ganado) + pago
      });

      try {
        await bot.telegram.sendMessage(
          id,
          `💰 Pago diario acreditado: ${pago.toFixed(2)} USDT (tasa ${(pct*100).toFixed(2)}%)\n` +
          `Disponible: ${(saldo + pago).toFixed(2)} USDT.`
        );
      } catch (_) {}

      pagados++;
    }

    await ctx.reply(`Pago diario ejecutado. Usuarios pagados: ${pagados}`);
  } catch (e) { console.log('/pagarhoy error:', e); }
});

// ================== Webhook (Render) ==================
const webhookPath = `/webhook/${BOT_TOKEN}`;
app.get('/', (_req, res) => res.send('FortunaMoney bot OK'));
app.get('/health', (_req, res) => res.send('OK'));

app.post(webhookPath, (req, res) => {
  try { console.log('>> Update recibido'); } catch (_) {}
  return bot.webhookCallback(webhookPath)(req, res);
});

app.listen(PORT, async () => {
  console.log('HTTP server on port', PORT);
  try {
    const url = `${HOST_URL}${webhookPath}`;
    await bot.telegram.setWebhook(url);
    console.log('Webhook configurado en:', url);
  } catch (e) { console.log('Error setWebhook:', e.message); }
});
