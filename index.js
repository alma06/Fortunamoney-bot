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
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25); // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE  || 400); // 1 USDT = 400 CUP

// Payout manual /pagarhoy
const RATE_SMALL = 0.015;  // < 500 USDT de base (bruto)
const RATE_BIG   = 0.02;   // ≥ 500 USDT de base (bruto)

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
function numero(x) { return Number(x || 0); }

// Crear solo si no existe (NO resetea)
async function asegurarUsuario(telegram_id) {
  const { data: u } = await supabase
    .from('usuarios').select('telegram_id').eq('telegram_id', telegram_id).maybeSingle();
  if (!u) await supabase.from('usuarios').insert([{ telegram_id }]);

  const { data: c } = await supabase
    .from('carteras').select('telegram_id').eq('telegram_id', telegram_id).maybeSingle();
  if (!c) {
    await supabase.from('carteras').insert([{
      telegram_id, saldo: 0, principal: 0, invertido: 0, bruto: 0
    }]);
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

  const row = {
    telegram_id,
    saldo: nuevoSaldo,
    principal: nuevoPrincipal,
    invertido: nuevoPrincipal, // mantener compatibilidad
    bruto: nuevoBruto
  };

  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}

// ======== UI Básica ========
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
        monto: montoFinal,       // monto USDT equivalente (para registro)
        moneda,
        monto_origen,           // monto en origen mostrado al admin
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

      // Respuesta al usuario
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
          `📥 Comprobante de DEPÓSITO\n` +
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
        `Fee descontado: ${fee.toFixed(2)} USDT\n\n` +
        `Si tu preferencia es CUP, el admin procesará tu pago en CUP (tasa fija).`,
        menu()
      );

      // Aviso admin
      try {
        const body =
          `🆕 Nuevo RETIRO pendiente\n` +
          `ID: #${retId}\n` +
          `Usuario: ${chatId}\n` +
          `Monto: ${monto.toFixed(2)} USDT\n` +
          `Fee: ${fee.toFixed(2)} USDT`;

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
      } catch (e3) {
        console.log('No pude avisar al admin/grupo (retiro):', e3?.message || e3);
      }

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
            [{ text: "✅ Aprobar depósito",  callback_data: `dep:approve:${dep.id}` }],
            [{ text: "❌ Rechazar depósito", callback_data: `dep:reject:${dep.id}` }]
          ]
        }
      });
    } catch (err) {
      console.error("Error enviando comprobante al grupo:", err);
    }
  } catch (e) {
    console.error("Error en handler de foto:", e);
  }
});

// ======== /tx id hash: agrega hash al depósito pendiente ========
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

    // Aviso admin
    const texto =
      '🔗 Hash recibido\n' +
      `Depósito: #${depId}\n` +
      `User: ${ctx.from.id}\n` +
      `Hash: ${hash}`;
    await bot.telegram.sendMessage(ADMIN_GROUP_ID, texto, {
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Aprobar',  callback_data: `dep:approve:${depId}` }],
        [{ text: '❌ Rechazar', callback_data: `dep:reject:${depId}`  }]
      ] }
    });

    await ctx.reply('Hash agregado al depósito.');
  } catch (e) { console.log(e); }
});

// ======== ADMIN: aprobar/rechazar depósito ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: d, error } = await supabase
      .from('depositos')
      .select('*')
      .eq('id', depId)
      .single();

    if (error || !d) return ctx.answerCbQuery('No encontrado');
    if (d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Acreditar:
    // - netoUsuario = 90% del depósito (10% a referidos)
    // - principal += netoUsuario
    // - saldo     += netoUsuario
    // - bruto     += depósito completo (base 500%)
    const carPrev = await carteraDe(d.telegram_id);
    const neto = numero(d.monto) * 0.9;
    const nuevoPrincipal = numero(carPrev.principal) + neto;
    const nuevoSaldo     = numero(carPrev.saldo)     + neto;
    const nuevoBruto     = numero(carPrev.bruto)     + numero(d.monto); // base usa 100%

    await actualizarCartera(d.telegram_id, {
      principal: nuevoPrincipal,
      saldo: nuevoSaldo,
      bruto: nuevoBruto
    });

    await supabase
      .from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    // Aviso al usuario
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
    } catch (eMsg) { console.log('No se pudo avisar al usuario:', eMsg?.message || eMsg); }

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito #${depId} aprobado.`);
  } catch (e) {
    console.log(e);
  }
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
    if (totalDebitar > numero(car.saldo)) return ctx.answerCbQuery('Saldo insuficiente (al aprobar).');

    await actualizarCartera(r.telegram_id, { saldo: numero(car.saldo) - totalDebitar });

    await supabase.from('retiros')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', rid);

    await bot.telegram.sendMessage(
      r.telegram_id,
      `Tu retiro de ${numero(r.monto).toFixed(2)} USDT fue APROBADO.`
    );

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);
  } catch (e) { console.log(e); }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);
    await bot.telegram.sendMessage(r.telegram_id, `Tu retiro #${rid} fue RECHAZADO.`);
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} rechazado.`);
  } catch (e) { console.log(e); }
});

// ======== /pagarhoy (ADMIN) ========
// Paga manualmente hoy (mar-dom), 1.5% o 2% según base 500% (bruto). Respeta tope 500%.
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const dow = new Date().getDay(); // 0=Dom, 1=Lun, 2=Mar,...
    if (dow === 1) { // lunes
      await ctx.reply('Hoy es lunes: no hay pago diario.');
      return;
    }

    // Traer todas las carteras
    const { data: carteras, error } = await supabase
      .from('carteras')
      .select('telegram_id, saldo, principal, bruto');

    if (error) {
      await ctx.reply('No pude leer carteras.');
      return;
    }

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
      const margen = Math.max(0, tope - totalActual); // cuánto falta para el 500%
      const acreditado = Math.min(pago, margen);

      if (acreditado > 0.0000001) {
        await actualizarCartera(c.telegram_id, { saldo: saldo + acreditado });
        totalPagado += acreditado;
        try {
          await bot.telegram.sendMessage(
            c.telegram_id,
            `💰 Pago diario acreditado: ${acreditado.toFixed(2)} USDT\n` +
            `Tasa: ${(rate*100).toFixed(2)}%  | Base: ${bruto.toFixed(2)} | Tope 500%: ${(5*bruto).toFixed(2)}`
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
