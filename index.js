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
const HOST_URL        = process.env.HOST_URL || ''; // https://tu-app.onrender.com
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'secret';
const PORT            = Number(process.env.PORT || 3000);

// Reglas
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25);  // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE  || 400); // 1 USDT = 400 CUP

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !ADMIN_GROUP_ID || !HOST_URL) {
  console.log('Faltan variables de entorno obligatorias.');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN, {
  telegram: { webhookReply: true }
});
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado en memoria ========
const estado = {}; // valores: 'INV_USDT' | 'INV_CUP' | 'RET'

// ======== Helpers ========
function numero(x) { return Number(x ?? 0) || 0; }
function menu() {
  return Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
}
function top500(bruto) { return numero(bruto) * 5; }
// Progreso SOLO con lo ganado (saldo + bono)
function progreso500({ saldo, bono, bruto }) {
  const top = top500(bruto);
  if (top <= 0) return 0;
  return ((numero(saldo) + numero(bono)) / top) * 100;
}

/* ========= ÚNICO CAMBIO IMPORTANTE =========
   Deja de usar upsert() con ceros que pisaba los valores.
   Ahora: solo crea si NO existe; y solo fija patrocinador
   si estaba vacío y llega un sponsor nuevo.
*/
async function asegurarUsuario(telegram_id, referido_por = null) {
  // -- USUARIO
  const { data: u } = await supabase
    .from('usuarios')
    .select('telegram_id, patrocinador_id')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (!u) {
    await supabase.from('usuarios').insert([{
      telegram_id,
      patrocinador_id: referido_por || null
    }]);
  } else if (!u.patrocinador_id && referido_por) {
    await supabase
      .from('usuarios')
      .update({ patrocinador_id: referido_por })
      .eq('telegram_id', telegram_id);
  }

  // -- CARTERA
  const { data: c } = await supabase
    .from('carteras')
    .select('telegram_id')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (!c) {
    await supabase.from('carteras').insert([{
      telegram_id,
      saldo: 0,
      principal: 0,
      bruto: 0,
      bono: 0
    }]);
  }
}
// =============== FIN DEL CAMBIO =================

async function carteraDe(telegram_id) {
  const { data } = await supabase
    .from('carteras')
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
    bono:      (patch.bono      !== undefined) ? numero(patch.bono)      : cur.bono
  };
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== Referral deep-link (/start ref=ID) ========
bot.start(async (ctx) => {
  try {
    const uid = ctx.from.id;
    let sponsor = null;

    // /start o /start ref_123
    const payload = ctx.startPayload || '';
    const m = payload.match(/^ref_(\d{5,})$/i);
    if (m) {
      sponsor = Number(m[1]);
      if (sponsor === uid) sponsor = null; // no se puede auto-referir
    }

    await asegurarUsuario(uid, sponsor);
    await ctx.reply('¡Bienvenido a FortunaMoney! Usa el menú 👇', menu());

  } catch (e) {
    console.log('START error:', e);
  }
});

// ======== Saldo ========
bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const c = await carteraDe(chatId);
    const total = c.principal + c.saldo + c.bono;
    const top = top500(c.bruto);
    const prog = progreso500(c);

    await ctx.reply(
      'Tu saldo (en USDT):\n\n' +
      `Principal (invertido):  ${c.principal.toFixed(2)}\n` +
      `Disponible:             ${c.saldo.toFixed(2)}\n` +
      `Bonos referidos:        ${c.bono.toFixed(2)}\n` +
      `Total:                  ${total.toFixed(2)}\n\n` +
      `Bruto (base 500%):      ${c.bruto.toFixed(2)}\n` +
      `Tope 500%:              ${top.toFixed(2)}\n` +
      `Progreso al 500%:       ${prog.toFixed(2)}%`,
      menu()
    );

  } catch (e) {
    console.log('ERROR Saldo:', e);
    try { await ctx.reply('Error obteniendo tu saldo. Intenta de nuevo.'); } catch {}
  }
});

// ======== Enlace de referidos ========
bot.hears('Referidos', async (ctx) => {
  const uid = ctx.from.id;
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
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
    `Tu saldo disponible es: ${car.saldo.toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT\n` +
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
    if (isNaN(monto) || monto <= 0) {
      await ctx.reply('Monto inválido. Intenta de nuevo.');
      return;
    }

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

      let moneda = (st === 'INV_USDT') ? 'USDT' : 'CUP';
      let monto_origen = monto;
      let tasa_usdt = null;
      let montoFinal = monto; // USDT equivalentes

      if (st === 'INV_CUP') {
        tasa_usdt = CUP_USDT_RATE;
        montoFinal = monto / tasa_usdt;
      }

      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: montoFinal,
        moneda,
        monto_origen,
        tasa_usdt,
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) {
        await ctx.reply('Error guardando el depósito. Intenta nuevamente.');
        return;
      }

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

      // Aviso al grupo admin
      try {
        const adminBody =
          `📥 DEPÓSITO pendiente\n` +
          `ID: #${depId}\n` +
          `User: ${chatId}\n` +
          `Monto: ${monto_origen.toFixed(2)} ${moneda}\n` +
          (moneda === 'CUP' ? `Equivalente: ${montoFinal.toFixed(2)} USDT\n` : ``) +
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
      } catch (e2) {
        console.log('No pude avisar al admin/grupo (depósito):', e2?.message || e2);
      }

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
        telegram_id: chatId,
        monto: monto,
        estado: 'pendiente'
      }]).select('id').single();

      if (insR.error) {
        await ctx.reply('No se pudo crear el retiro. Intenta nuevamente.');
        return;
      }

      const retId = insR.data.id;
      await ctx.reply(
        `✅ Retiro creado (pendiente).\n\n` +
        `ID: ${retId}\n` +
        `Monto: ${monto.toFixed(2)} USDT\n` +
        `Fee descontado: ${fee.toFixed(2)} USDT`,
        menu()
      );

      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `🆕 RETIRO pendiente\nID: #${retId}\nUsuario: ${chatId}\nMonto: ${monto.toFixed(2)} USDT`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar retiro',  callback_data: `ret:approve:${retId}` }],
                [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}`  }]
              ]
            }
          }
        );
      } catch {}
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

    if (!dep) return ctx.reply('No encuentro un depósito pendiente.');

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
    console.error("Error en handler de foto:", e);
  }
});

// ======== Aprobar/Rechazar Depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Acreditar: principal +90%, BRUTO +100% (no toca saldo)
    const carPrev = await carteraDe(d.telegram_id);
    const montoNeto = numero(d.monto) * 0.90;
    const nuevoPrincipal = carPrev.principal + montoNeto;
    const nuevoBruto     = carPrev.bruto     + numero(d.monto);

    await actualizarCartera(d.telegram_id, {
      principal: nuevoPrincipal,
      bruto: nuevoBruto
    });

    // Marcar depósito como aprobado
    await supabase.from('depositos')
      .update({ estado: 'aprobado' })
      .eq('id', depId);

    // Pagar 10% al patrocinador CAPEADO por tope (saldo/bono cuentan hacia el 500%)
    try {
      const { data: u } = await supabase
        .from('usuarios')
        .select('patrocinador_id')
        .eq('telegram_id', d.telegram_id)
        .maybeSingle();

      const sponsor = u?.patrocinador_id ? Number(u.patrocinador_id) : null;
      if (sponsor) {
        const bonoBruto = numero(d.monto) * 0.10;
        const carS = await carteraDe(sponsor);

        const topS = top500(carS.bruto);
        const ganadoS = carS.saldo + carS.bono;
        const margenS = topS - ganadoS;

        const bonoFinal = Math.max(0, Math.min(bonoBruto, margenS));
        if (bonoFinal > 0) {
          await actualizarCartera(sponsor, {
            saldo: carS.saldo + bonoFinal,
            bono:  carS.bono  + bonoFinal
          });
          try {
            await bot.telegram.sendMessage(
              sponsor,
              `🎉 Bono de referido acreditado: ${bonoFinal.toFixed(2)} USDT\n` +
              `Por el depósito de tu referido ${d.telegram_id}.`
            );
          } catch {}
        }
      }
    } catch (e) { console.log('BONO ref error:', e); }

    // Aviso al usuario
    try {
      await bot.telegram.sendMessage(
        d.telegram_id,
        `✅ Depósito aprobado: ${numero(d.monto).toFixed(2)} USDT.\n` +
        `A tu principal se acreditó: ${montoNeto.toFixed(2)} USDT.\n` +
        `Bruto (base 500%): ${nuevoBruto.toFixed(2)} USDT.`
      );
    } catch {}

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito aprobado: ${numero(d.monto).toFixed(2)} USDT`);

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
    const totalDebitar = r.monto + RETIRO_FEE_USDT;
    if (totalDebitar > car.saldo) return ctx.answerCbQuery('Saldo insuficiente');

    await actualizarCartera(r.telegram_id, { saldo: car.saldo - totalDebitar });
    await supabase.from('retiros').update({ estado: 'aprobado' }).eq('id', rid);

    await bot.telegram.sendMessage(r.telegram_id, `✅ Retiro aprobado: ${r.monto.toFixed(2)} USDT`);
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

// ======== /pagarhoy (pago manual de ganancias) ========
// Regla: principal < 500 => 1.5% ; principal >= 500 => 2%
// Puedes ejecutarlo N veces al día; siempre respeta el tope 500% con GANADO (saldo+bono).
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Solo admin.');
  try {
    const { data: carteras } = await supabase
      .from('carteras')
      .select('telegram_id, saldo, principal, bruto, bono');

    if (!carteras || !carteras.length) return ctx.reply('No hay carteras.');

    let totalPagado = 0;
    let cuentasPagadas = 0;

    for (const c of carteras) {
      const principal = numero(c.principal);
      const bruto = numero(c.bruto);
      if (principal <= 0 || bruto <= 0) continue;

      const rate = principal >= 500 ? 0.02 : 0.015;
      let pago = principal * rate;

      // CAP por tope: solo cuenta lo ganado (saldo+bono)
      const top = top500(bruto);
      const ganado = numero(c.saldo) + numero(c.bono);
      const margen = top - ganado;
      if (margen <= 0) continue;

      if (pago > margen) pago = margen;
      if (pago <= 0) continue;

      await actualizarCartera(c.telegram_id, { saldo: numero(c.saldo) + pago });
      totalPagado += pago;
      cuentasPagadas += 1;

      try {
        await bot.telegram.sendMessage(
          c.telegram_id,
          `💸 Pago diario acreditado: ${pago.toFixed(2)} USDT`
        );
      } catch {}
    }

    await ctx.reply(`✅ /pagarhoy completado.\nCuentas pagadas: ${cuentasPagadas}\nTotal pagado: ${totalPagado.toFixed(2)} USDT`);

  } catch (e) {
    console.log('/pagarhoy error:', e);
    try { await ctx.reply('Error en pagarhoy. Revisa logs.'); } catch {}
  }
});

// ======== Webhook / Ping ========
app.get('/', (_, res) => res.send('OK'));
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => bot.handleUpdate(req.body, res));
app.get('/webhook', async (_, res) => {
  try {
    const url = `${HOST_URL}/webhook/${WEBHOOK_SECRET}`;
    await bot.telegram.setWebhook(url);
    res.send(`Webhook configurado en: ${url}`);
  } catch (e) {
    console.log('setWebhook error:', e);
    res.status(500).send('Error configurando webhook');
  }
});

// Lanzar servidor + webhook
app.listen(PORT, async () => {
  console.log(`HTTP server on port ${PORT}`);
  try {
    const url = `${HOST_URL}/webhook/${WEBHOOK_SECRET}`;
    await bot.telegram.setWebhook(url);
    console.log(`Webhook configurado en: ${url}`);
  } catch (e) {
    console.log('setWebhook error:', e);
  }
});

// Paradas elegantes
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
