// ================== FortunaMoney Bot (Webhook + Cron HTTP) ==================
// Depósitos con comprobante (hash + foto), aprobación manual por admin
// Pago diario automático vía endpoint /run-pago (llamado por cron externo a las 12:00 Madrid)
// Tasa: 1.5% si BRUTO < 500 USDT, 2% si >= 500 USDT
// 10% al patrocinador y 90% al principal neto
// Tope total: 500% del BRUTO (bruto = neto / 0.9)
// ======================================================

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
const WALLET_USDT    = process.env.WALLET_USDT || 'WALLET_NO_CONFIGURADA';
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID ? Number(process.env.ADMIN_GROUP_ID) : null;
const CUP_PER_USDT = Number(process.env.CUP_PER_USDT || 400);

const HOST_URL       = process.env.HOST_URL || ''; // URL pública (Render)
const CRON_SECRET    = process.env.CRON_SECRET || 'cambia_esto';
const PORT           = process.env.PORT || 3000;

// Reglas nuevas
const MIN_INVERSION   = 25; // USDT
const RETIRO_FEE_USDT = 1;  // USDT

// === Conversión CUP a USDT (1 CUP -> USDT). Si 1 USDT = 400 CUP => 1 CUP = 0.0025 USDT
const CUP_USDT_RATE = Number(process.env.CUP_USDT_RATE || 0.0025);

// Estado temporal de la inversión (moneda elegida en el paso previo)
const monedaInv = {}; // monedaInv[chatId] = 'USDT' | 'CUP'

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY || !ADMIN_ID || !WALLET_USDT) {
  console.log('Faltan variables en .env (BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY, ADMIN_ID, WALLET_USDT)');
  process.exit(1);
}

// ======== INIT ========
const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Estado sencillo en memoria
const estado = {}; // estado[chatId] = 'INV' | 'RET'

// ======== Helpers UI ========
function menu() {
  return Markup.keyboard([
    ['Invertir'],
    ['Retirar'],
    ['Saldo'],
    ['Referidos']
  ]).resize();
}

// Inline keyboards (aprobación/rechazo)
function kbDep(idDep) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Aprobar', 'dep:approve:' + idDep),
      Markup.button.callback('Rechazar', 'dep:reject:' + idDep)
    ]
  ]);
}
function kbRet(idRet) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Aprobar retiro', 'ret:approve:' + idRet),
      Markup.button.callback('Rechazar retiro', 'ret:reject:' + idRet)
    ]
  ]);
}
function kbMetodoInv() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('USDT (BEP20)', 'inv:usdt')],
    [Markup.button.callback('CUP (Tarjeta)', 'inv:cup')],
  ]);
}
function kbMoneda() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('USDT (BEP20)', 'curr:USDT') ],
    [ Markup.button.callback('CUP (tarjeta)', 'curr:CUP') ],
  ]);
}
// ======== Helpers BD ========
async function asegurarUsuario(telegram_id) {
  let { data: u } = await supabase.from('usuarios')
    .select('telegram_id').eq('telegram_id', telegram_id).single();
  if (!u) await supabase.from('usuarios').insert([{ telegram_id }]);

  let { data: c } = await supabase.from('carteras')
    .select('telegram_id').eq('telegram_id', telegram_id).single();
  if (!c) await supabase.from('carteras').insert([{ telegram_id, saldo: 0, invertido: 0 }]);
}

async function carteraDe(id) {
  const { data, error } = await supabase.from('carteras')
    .select('saldo, invertido').eq('telegram_id', id).single();
  if (error) throw error;
  return data;
}

async function actualizarCartera(id, campos) {
  const { error } = await supabase.from('carteras').update(campos).eq('telegram_id', id);
  if (error) throw error;
}

async function totalRetirado(id) {
  const { data } = await supabase.from('retiros')
    .select('monto').eq('telegram_id', id).eq('estado', 'aprobado');
  let s = 0; (data || []).forEach(r => s += Number(r.monto || 0));
  return s;
}

async function patrocinadorDe(userId) {
  const { data, error } = await supabase
    .from('referidos')
    .select('patrocinador_id')
    .eq('referido_id', userId)
    .single();
  if (error || !data) return null;
  return data.patrocinador_id;
}

async function registrarReferencia(patroId, referidoId) {
  if (!patroId || !referidoId || patroId === referidoId) return;
  const { data } = await supabase.from('referidos')
    .select('id').eq('referido_id', referidoId).single();
  if (!data) await supabase.from('referidos').insert([{ patrocinador_id: patroId, referido_id: referidoId }]);
}
async function monedaPreferidaDe(userId) {
  const { data } = await supabase
    .from('usuarios')
    .select('moneda_preferida')
    .eq('telegram_id', userId)
    .single();
  return (data && data.moneda_preferida) ? data.moneda_preferida : 'USDT';
}
// ======== Avisos admin/grupo ========
async function avisarAdmin(msg, extra) {
  try {
    if (ADMIN_GROUP_ID) await bot.telegram.sendMessage(ADMIN_GROUP_ID, msg, extra || {});
    else if (ADMIN_ID)  await bot.telegram.sendMessage(ADMIN_ID, msg, extra || {});
  } catch (e) {
    console.log('No pude avisar a admin:', e.message || e);
  }
}

async function avisarAdminFoto(fileId, caption, extra) {
  try {
    if (ADMIN_GROUP_ID) {
      await bot.telegram.sendPhoto(ADMIN_GROUP_ID, fileId, { caption, ...(extra || {}) });
    } else if (ADMIN_ID) {
      await bot.telegram.sendPhoto(ADMIN_ID, fileId, { caption, ...(extra || {}) });
    }
  } catch (e) {
    console.log('No pude enviar foto a admin:', e.message || e);
  }
}

// ======== Finanzas ========
function tasaSegunBruto(brutoTotal) { return brutoTotal >= 500 ? 0.02 : 0.015; }
function brutoDesdeNeto(neto) { return neto > 0 ? (neto / 0.9) : 0; }
function tope500Bruto(bruto) { return bruto * 5.0; }

// ================== Pago diario ==================
async function pagarDiario() {
  try {
    // Obtengo usuarios desde la base de datos
    let usuarios = await db.getData('/usuarios');
    let count = 0;

    for (let uid in usuarios) {
      let u = usuarios[uid];

      // Solo paga si aún no llegó al tope (500%)
      if (u.bruto < tope500Proc(u.invertido)) {
        const tasa = tasaSegunMonto(u.invertido); // 0.02 o 0.015
        const ganancia = u.invertido * tasa;

        u.disponible = (u.disponible || 0) + ganancia;
        u.bruto = (u.bruto || 0) + ganancia;

        count++;
      }
    }

    // Guardo los cambios en la base de datos
    await db.push('/usuarios', usuarios);
    return count; // cantidad de usuarios pagados
  } catch (e) {
    console.log("Error en pagarDiario:", e);
    return 0;
  }
}
// === Handlers Bot ===
bot.command('pagarhoy', async (ctx) => {
    // Solo el admin puede ejecutar este comando
    if (ctx.from.id !== ADMIN_ID) return;

    const n = await pagarDiario();
    await ctx.reply(`Pago diario ejecutado. Usuarios pagados: ${n}`);
});

bot.start(async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    const text = ctx.message.text || '';
    const partes = text.split(' ');
    if (partes.length > 1) {
      const arg = partes[1];
      if (arg.indexOf('ref_') === 0) {
        const patroId = Number(arg.replace('ref_', ''));
        if (patroId && patroId !== chatId) {
          await registrarReferencia(patroId, chatId);
        }
      }
    }

    await ctx.reply('Bienvenido. Usa el menú:', menu());
  } catch (e) {
    console.log(e);
    await ctx.reply('Ocurrió un error al iniciar.');
  }
});

// 👇 Agrega el comando de prueba aquí
bot.command('testcanal', async (ctx) => {
  const id = process.env.PAYMENT_CHANNEL_ID;
  try {
    const chat = await bot.telegram.getChat(id);
    await ctx.reply(`Canal detectado: ${chat.title} (id=${chat.id}). Intentando postear...`);
    await bot.telegram.sendMessage(id, '✅ Prueba de posteo desde el bot (testcanal).');
    await ctx.reply('Listo: publicado en el canal.');
  } catch (e) {
    await ctx.reply('❌ Falló: ' + (e?.description || e?.message || String(e)));
  }
});

bot.hears('Invertir', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    await ctx.reply(
      'Elige método de inversión:',
      Markup.inlineKeyboard([
        [Markup.button.callback('USDT (BEP20)', 'curr:USDT')],
        [Markup.button.callback('CUP (tarjeta)', 'curr:CUP')],
      ])
    );
  } catch (e) { console.log(e); }
});

bot.hears('Retirar', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    const car = await carteraDe(chatId);

    await ctx.reply(
      'Tu saldo disponible es: ' + Number(car.saldo || 0).toFixed(2) + ' USDT\n' +
      'Fee de retiro: ' + RETIRO_FEE_USDT + ' USDT (se descuenta además del monto solicitado).\n' +
      'Escribe el monto a retirar (solo número, ej: 25.00)'
    );

    estado[chatId] = 'RET';               // <-- IMPORTANTE
  } catch (e) { console.log(e); }
});

bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    const car = await carteraDe(chatId);

    const invertidoNeto = Number(car.invertido || 0);
    const disponible = Number(car.saldo || 0);
    const bruto = brutoDesdeNeto(invertidoNeto);
    const retirado = await totalRetirado(chatId);
    const tope = tope500Bruto(bruto);
    const pagadoHastaAhora = disponible + retirado;
    const progreso = tope > 0 ? Math.min(100, (pagadoHastaAhora / tope) * 100) : 0;

    // Buscar último depósito APROBADO en CUP del usuario
    let detalleCUP = '';
    try {
      const { data: depCup } = await supabase
        .from('depositos')
        .select('monto_origen, monto, tasa_usdt, moneda')
        .eq('telegram_id', chatId)
        .eq('estado', 'aprobado')
        .eq('moneda', 'CUP')
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (depCup && depCup.moneda === 'CUP') {
        detalleCUP =
          `\nÚltimo depósito CUP: ${Number(depCup.monto_origen || 0).toFixed(2)} CUP ` +
          `→ ${Number(depCup.monto || 0).toFixed(2)} USDT @ tasa ${Number(depCup.tasa_usdt || 0).toFixed(2)}.`;
      }
    } catch (e) {
      console.log('No se pudo consultar detalle CUP:', e?.message || e);
    }

    await ctx.reply(
      'Tu saldo (en USDT):\n' +
      `\n Principal (invertido):  ${invertidoNeto.toFixed(2)}` +
      `\n Disponible:            ${disponible.toFixed(2)}` +
      `\n Total:                 ${(invertidoNeto + disponible).toFixed(2)}` +
      '\n' +
      `\n Bruto (base para 500%): ${bruto.toFixed(2)}` +
      `\n Progreso hacia 500%:    ${progreso.toFixed(2)}%` +
      detalleCUP
    );
  } catch (e) { console.log(e); }
});

// Pago manual para pruebas (también expuesto como /run-pago)
async function pagarDiario() {
  try {
    const { data: carteras, error } = await supabase.from('carteras')
      .select('telegram_id, saldo, invertido');
    if (error) { console.log('Error listando carteras', error); return 0; }

    let pagados = 0;
    for (const c of (carteras || [])) {
      const id = c.telegram_id;
      const invertido = Number(c.invertido || 0);
      const saldo = Number(c.saldo || 0);
      if (invertido <= 0) continue;

      const brutoTotal = brutoDesdeNeto(invertido);
      const pct = tasaSegunBruto(brutoTotal);
      const interes = invertido * pct;

      const tope = tope500Bruto(brutoTotal);
      const retirado = await totalRetirado(id);
      const pagadoHastaAhora = saldo + retirado;
      if (pagadoHastaAhora >= tope) continue;

      const margen = tope - pagadoHastaAhora;
      const pago = interes > margen ? margen : interes;
      const nuevoSaldo = saldo + pago;

      await actualizarCartera(id, { saldo: nuevoSaldo });

      try {
        await bot.telegram.sendMessage(
          id,
          'Pago acreditado: ' + pago.toFixed(2) + ' USDT (tasa ' + (pct * 100).toFixed(2) + '%).\n' +
          'Disponible: ' + nuevoSaldo.toFixed(2) + ' USDT.'
        );
      } catch (eMsg) { console.log('No se pudo avisar a ' + id, eMsg.message || eMsg); }

      pagados++;
    }
    return pagados;
  } catch (e) { console.log('Error en pagarDiario', e); return 0; }
}

bot.command('pagarhoy', async (ctx) => {
  const n = await pagarDiario();
  await ctx.reply('Pago diario ejecutado. Usuarios pagados: ' + n);
});
// ==== Texto: flujos de invertir y retirar ====

// Opción USDT
bot.action('inv:usdt', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    estado[chatId] = 'INV_USDT';
    await ctx.answerCbQuery();
    await ctx.reply(`Escribe el monto a invertir (mínimo ${MIN_INVERSION} USDT). Solo número, ejemplo: 50.00`);
  } catch (e) { console.log(e); }
});

// Opción CUP
bot.action('inv:cup', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    estado[chatId] = 'INV_CUP';
    await ctx.answerCbQuery();
    await ctx.reply('Escribe el monto a invertir en CUP (mínimo 500 CUP). Solo número, ejemplo: 20000');
  } catch (e) { console.log(e); }
});

// Usuario elige USDT
bot.action('curr:USDT', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    monedaInv[chatId] = 'USDT';

    await supabase.from('usuarios')
      .update({ moneda_preferida: 'USDT' })
      .eq('telegram_id', chatId)
      .is('moneda_preferida', null);

    await ctx.answerCbQuery('Moneda: USDT');
    await ctx.editMessageReplyMarkup();
    await ctx.reply(
      `Escribe el monto a invertir en USDT (mínimo ${MIN_INVERSION}). Solo número, ej: 50.00`
    );
  } catch (e) { console.log(e); }
});

// Usuario elige CUP
bot.action('curr:CUP', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    monedaInv[chatId] = 'CUP';

    await supabase.from('usuarios')
      .update({ moneda_preferida: 'CUP' })
      .eq('telegram_id', chatId)
      .is('moneda_preferida', null);

    await ctx.answerCbQuery('Moneda: CUP');
    await ctx.editMessageReplyMarkup();
    await ctx.reply(
      'Escribe el monto a invertir en CUP (mínimo 500 CUP). Solo número, ej: 20000'
    );
  } catch (e) { console.log(e); }
});

// ================== HANDLER ÚNICO DE TEXTO ==================
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const txtRaw = (ctx.message.text || '').trim();
    if (txtRaw.startsWith('/')) return; // no comerse comandos

    const st = estado[chatId]; // 'INV_USDT' | 'INV_CUP' | 'RET' | undefined
    if (!['INV_USDT', 'INV_CUP', 'RET'].includes(st)) return;

    // =========================================================
    // RETIRAR
    // =========================================================
    if (st === 'RET') {
      try {
        const fee = Number(process.env.RETIRO_FEE_USDT || 1);
        const monto = Number(txtRaw.replace(',', '.'));

        if (isNaN(monto) || monto <= 0) {
          await ctx.reply('Monto inválido. Intenta de nuevo.');
          return;
        }

        // Asegura usuario y lee saldo
        await asegurarUsuario(chatId);
        const car = await carteraDe(chatId);
        const disp = Number(car?.saldo || 0);
        const totalDebitar = monto + fee;

        if (totalDebitar > disp) {
          await ctx.reply(
            'Saldo insuficiente. Tu disponible es ' + disp.toFixed(2) + ' USDT\n' +
            'y se necesita ' + totalDebitar.toFixed(2) + ' USDT (monto + fee).'
          );
          return;
        }

        // Debitar y crear retiro
        await actualizarCartera(chatId, { saldo: disp - totalDebitar });

        const insR = await supabase.from('retiros').insert([{
          telegram_id: chatId,
          monto: monto,
          estado: 'pendiente'
        }]).select('id').single();

        if (insR.error) {
          console.log('Error insert retiro:', insR.error);
          await ctx.reply('No se pudo crear el retiro. Intenta nuevamente.');
          estado[chatId] = undefined;
          return;
        }

        const rid = insR.data.id;

        await ctx.reply(
          'Retiro solicitado por ' + monto.toFixed(2) + ' USDT.\n' +
          'Fee descontado: ' + fee.toFixed(2) + ' USDT.\n' +
          'Estado: pendiente.'
        );

        estado[chatId] = undefined; // limpiar estado

        // Aviso al admin con botones (usa tu helper kbRet)
        try {
          const texto =
            '📤 Nuevo RETIRO pendiente\n' +
            'ID: #' + rid + '\n' +
            'User: ' + chatId + '\n' +
            'Monto: $' + monto.toFixed(2) + ' USDT';
          await bot.telegram.sendMessage(
            ADMIN_GROUP_ID,
            texto,
            { reply_markup: kbRet(rid).reply_markup }
          );
        } catch (e2) {
          console.log('No pude avisar al admin/grupo (retiro):', e2.message || e2);
        }

        return; // IMPORTANTÍSIMO: no continuar al flujo de depósitos
      } catch (e) {
        console.log('Error en RET:', e);
        await ctx.reply('Ocurrió un error procesando tu mensaje.');
        return;
      }
    }

    // =========================================================
    // INVERTIR (DEPÓSITO)
    // =========================================================

    // Normaliza y valida número
    const monto = Number(txtRaw.replace(',', '.'));
    if (isNaN(monto) || monto <= 0) {
      await ctx.reply('Monto inválido. Intenta de nuevo.');
      return;
    }

    // Mínimos por método
    if (st === 'INV_USDT' && monto < MIN_INVERSION) {
      await ctx.reply(`El mínimo de inversión es ${MIN_INVERSION} USDT.`);
      return;
    }
    if (st === 'INV_CUP' && monto < 500) {
      await ctx.reply('El mínimo de inversión es 500 CUP.');
      return;
    }

    // Asegurar usuario
    await asegurarUsuario(chatId);

    // Preparar datos y conversión (si CUP)
    let montoFinal = monto;                 // se guarda SIEMPRE en USDT
    let moneda = (st === 'INV_USDT') ? 'USDT' : 'CUP';
    let tasa_usdt = null;
    let monto_origen = monto;

    if (st === 'INV_CUP') {
      const rate = Number(process.env.CUP_USDT_RATE || 400); // 1 USDT = 400 CUP (default)
      tasa_usdt = rate;
      montoFinal = monto / rate; // convertir CUP -> USDT
    }

    // Guardar depósito
    const ins = await supabase.from('depositos').insert([{
      telegram_id: chatId,
      monto: montoFinal,        // SIEMPRE en USDT
      moneda,                   // 'USDT' | 'CUP' (para saber con qué pagas el retiro)
      monto_origen,             // lo que escribió el usuario
      tasa_usdt,                // null si fue USDT directo
      estado: 'pendiente'
    }]).select('id').single();

    if (ins.error) {
      console.log('Error insert depósito:', ins.error);
      await ctx.reply('Error guardando el depósito. Intenta nuevamente.');
      return;
    }

    const depId = ins.data.id;

    // Respuesta al usuario
    await ctx.reply(
      '✅ Depósito creado (pendiente).\n\n' +
      'ID: ' + depId + '\n' +
      'Monto: $' + monto_origen.toFixed(2) + ' ' + moneda + '\n' +
      (moneda === 'CUP' ? ('Equivalente: ' + montoFinal.toFixed(2) + ' USDT\n') : '') +
      '• Envía el hash de la transacción (USDT) o una foto/captura del pago (CUP) en este chat.\n' +
      '• Cuando el admin confirme la recepción, tu inversión será acreditada.'
    );

    // Aviso al grupo admin con botones aprobar/rechazar
    try {
      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        '📩 Comprobante de DEPÓSITO\n' +
        'ID: #' + depId + '\n' +
        'User: ' + chatId + '\n' +
        'Monto: $' + monto_origen.toFixed(2) + ' ' + moneda + '\n' +
        (moneda === 'CUP' ? ('Equivalente: ' + montoFinal.toFixed(2) + ' USDT\n') : '') +
        'Usa los botones para validar.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Aprobar',  callback_data: 'dep:approve:' + depId }],
              [{ text: 'Rechazar', callback_data: 'dep:reject:'  + depId }]
            ]
          }
        }
      );
    } catch (e2) {
      console.log('No pude avisar al admin/grupo (depósito):', e2.message || e2);
    }

    // limpiar estado para no “comerse” el siguiente mensaje
    estado[chatId] = undefined;
  } catch (e) {
    console.log('Error en handler de texto:', e);
    try { await ctx.reply('Ocurrió un error procesando tu mensaje.'); } catch {}
  }
});

// Foto: guarda comprobante en depósito más reciente pendiente y lo manda al grupo
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

    if (!dep) return ctx.reply('No encuentro un depósito pendiente para guardar tu comprobante.');

    await supabase.from('depositos').update({ proof_file_id: fileId }).eq('id', dep.id);
    await ctx.reply('Comprobante guardado para el depósito #' + dep.id + '.');

    // Enviar la foto al grupo con botones
    try {
      const caption = 'Comprobante de DEPÓSITO\n' +
                      'ID: #' + dep.id + '\n' +
                      'User: ' + uid + '\n' +
                      'Usa los botones para validar.';
      await avisarAdminFoto(fileId, caption, { reply_markup: kbDep(dep.id).reply_markup });
    } catch (e) { console.log('No pude mandar la foto al admin/grupo:', e.message || e); }

  } catch (e) { console.log(e); }
});

// /tx: guarda hash en un depósito pendiente del usuario y lo manda al grupo
bot.command('tx', async (ctx) => {
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 3) return ctx.reply('Uso: /tx <id_deposito> <hash>');
  const depId = Number(parts[1]);
  const hash = parts.slice(2).join(' ');

  const { data: dep } = await supabase.from('depositos')
    .select('id, telegram_id, estado').eq('id', depId).single();

  if (!dep || dep.telegram_id !== ctx.from.id) return ctx.reply('No encuentro ese depósito pendiente a tu nombre.');
  if (dep.estado !== 'pendiente') return ctx.reply('Ese depósito ya no está pendiente.');

  await supabase.from('depositos').update({ tx: hash }).eq('id', depId);
  await ctx.reply('Hash guardado para el depósito #' + depId + '.');

  // Aviso al grupo con botones
  const texto = 'Hash recibido\n' +
                'Depósito: #' + depId + '\n' +
                'User: ' + ctx.from.id + '\n' +
                'Hash: ' + hash;
  try {
    await avisarAdmin(texto, { reply_markup: kbDep(depId).reply_markup });
  } catch (e) {
    console.log('No pude avisar hash al admin/grupo:', e.message || e);
  }
});

// ======= ADMIN – Depósitos (listado y foto) =======
bot.command('pendientes', async (ctx) => {
  if (ctx.from.id != ADMIN_ID && ctx.chat.id != ADMIN_GROUP_ID) return;
  const { data, error } = await supabase.from('depositos')
    .select('id, telegram_id, monto, creado_en, tx, proof_file_id')
    .eq('estado', 'pendiente').order('id', { ascending: true });
  if (error) return ctx.reply('Error listando pendientes.');
  if (!data || data.length === 0) return ctx.reply('Sin depósitos pendientes.');

  let msg = 'Depósitos pendientes:\n';
  data.forEach(d => {
    msg += `#${d.id} \n` +
           `👤 User: ${d.telegram_id}\n` +
           `💰 ${Number(d.monto).toFixed(2)} USDT\n` +
           `📌 Hash: ${d.tx ? 'SI' : 'NO'}\n` +
           `📷 Foto: ${d.proof_file_id ? 'SI' : 'NO'}\n\n`;
  });
  await ctx.reply(msg);
});

bot.command('verfoto', async (ctx) => {
  if (ctx.from.id != ADMIN_ID && ctx.chat.id != ADMIN_GROUP_ID) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Uso: /verfoto <id_deposito>');
  const depId = Number(parts[1]);

  const { data: dep } = await supabase.from('depositos')
    .select('proof_file_id').eq('id', depId).single();
  if (!dep) return ctx.reply('Depósito no encontrado.');
  if (!dep.proof_file_id) return ctx.reply('Ese depósito no tiene foto.');

  try { 
    await ctx.replyWithPhoto(dep.proof_file_id); 
  }
  catch (e) { 
    console.log(e); 
    await ctx.reply('No pude enviar la foto (file_id inválido).'); 
  }
});

// ======= ADMIN – Acciones DEPÓSITO por botones =======
// Aprueba depósito
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: dep } = await supabase
      .from('depositos')
      .select('id, telegram_id, estado, monto, moneda, monto_origen, tasa_usdt')
      .eq('id', depId)
      .single();

    if (!dep) return ctx.answerCbQuery('Depósito no encontrado');
    if (dep.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Acreditar en cartera (sumar al INVERTIDO el monto en USDT equivalente)
    const { data: car } = await supabase
      .from('carteras')
      .select('invertido')
      .eq('telegram_id', dep.telegram_id)
      .single();

    const invertidoActual = Number(car?.invertido || 0);
    const nuevoInvertido = invertidoActual + Number(dep.monto || 0);

    await supabase
      .from('carteras')
      .update({ invertido: nuevoInvertido })
      .eq('telegram_id', dep.telegram_id);

    // Marcar depósito aprobado
    await supabase
      .from('depositos')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', depId);

    // Avisar al usuario
    await bot.telegram.sendMessage(
      dep.telegram_id,
      `✅ Depósito #${depId} APROBADO\n` +
      `Monto acreditado: ${Number(dep.monto).toFixed(2)} USDT` +
      (dep.moneda === 'CUP'
        ? ` (proveniente de ${Number(dep.monto_origen).toFixed(2)} CUP a tasa ${dep.tasa_usdt})`
        : '')
    );

    // Quitar los botones del mensaje admin
    try { await ctx.editMessageReplyMarkup(); } catch (_) {}

    await ctx.answerCbQuery('Depósito aprobado ✔️');
  } catch (e) {
    console.log('Error dep:approve:', e);
    try { await ctx.answerCbQuery('Error aprobando'); } catch {}
  }
});

// Rechaza depósito
bot.action(/dep:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);

    const { data: dep } = await supabase
      .from('depositos')
      .select('id, telegram_id, estado, monto_origen, moneda')
      .eq('id', depId)
      .single();

    if (!dep) return ctx.answerCbQuery('Depósito no encontrado');
    if (dep.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    await supabase
      .from('depositos')
      .update({ estado: 'rechazado', rechazado_en: new Date().toISOString() })
      .eq('id', depId);

    // Aviso al usuario
    await bot.telegram.sendMessage(
      dep.telegram_id,
      `❌ Depósito #${depId} RECHAZADO.\n` +
      `Monto: ${Number(dep.monto_origen).toFixed(2)} ${dep.moneda}.`
    );

    // Quitar botones
    try { await ctx.editMessageReplyMarkup(); } catch (_) {}

    await ctx.answerCbQuery('Depósito rechazado ❌');
  } catch (e) {
    console.log('Error dep:reject:', e);
    try { await ctx.answerCbQuery('Error rechazando'); } catch {}
  }
});
// ======== ADMIN – Aprobar retiro (descuenta en USDT pero paga en CUP) ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);

    const { data: r } = await supabase
      .from('retiros')
      .select('*')
      .eq('id', rid)
      .single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    // Tasa fija (CUP por USDT). Toma del .env o usa 400 por defecto.
    const rate = Number(process.env.CUP_USDT_RATE || 400);

    // Monto que se pagará en CUP (redondeo hacia abajo a entero)
    const montoUSDT = Number(r.monto);
    const pagarCUP = Math.floor(montoUSDT * rate);

    // Marca como aprobado y registra cómo se pagó
    await supabase
      .from('retiros')
      .update({
        estado: 'aprobado',
        aprobado_en: new Date().toISOString(),
        moneda_pago: 'CUP',
        tasa_usdt: rate,
        monto_pago_cup: pagarCUP
      })
      .eq('id', rid);

    // Aviso al usuario
    try {
      await bot.telegram.sendMessage(
        r.telegram_id,
        `✅ Tu retiro de ${montoUSDT.toFixed(2)} USDT fue APROBADO.\n` +
        `Se pagará en CUP: ${pagarCUP} CUP @ ${rate} CUP/USDT.`
      );
    } catch {}

    // Quita los botones del mensaje de admin
    await ctx.editMessageReplyMarkup();

    // Aviso en el grupo admin
    await ctx.reply(
      `✅ Retiro #${rid} aprobado.\n` +
      `Usuario: ${r.telegram_id}\n` +
      `Descontado: ${montoUSDT.toFixed(2)} USDT (del saldo)\n` +
      `A pagar: ${pagarCUP} CUP @ ${rate} CUP/USDT`
    );

    // (Opcional) Aviso al canal de pagos si tienes PAYMENT_CHANNEL_ID configurado
    if (process.env.PAYMENT_CHANNEL_ID) {
      try {
        await bot.telegram.sendMessage(
          process.env.PAYMENT_CHANNEL_ID,
          `💸 Pago de retiro aprobado\n` +
          `Usuario: ${r.telegram_id}\n` +
          `Equivalente: ${montoUSDT.toFixed(2)} USDT\n` +
          `Pagado: ${pagarCUP} CUP @ ${rate} CUP/USDT`
        );
      } catch (e) { console.log('No pude avisar al canal de pagos:', e?.message || e); }
    }

  } catch (e) { console.log(e); }
});

// ======== ADMIN – Retiros (lista) ========
bot.command('retiros', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const filtro = Number(parts[1]) || null;

  let q = supabase.from('retiros')
    .select('id, telegram_id, monto, estado')
    .eq('estado', 'pendiente').order('id', { ascending: true });
  if (filtro) q = q.eq('telegram_id', filtro);

  const { data, error } = await q;
  if (error) return ctx.reply('Error listando retiros.');
  if (!data || data.length === 0) return ctx.reply('Sin retiros pendientes.');

  let msg = 'Retiros pendientes:\n';
  data.forEach(r => { msg += '#' + r.id + ' | user ' + r.telegram_id + ' | ' + Number(r.monto).toFixed(2) + ' USDT\n'; });
  await ctx.reply(msg);
});

// ======== ADMIN - Acciones retiro por botones ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);

    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    await supabase
      .from('retiros')
      .update({ estado: 'aprobado', aprobado_en: new Date().toISOString() })
      .eq('id', rid);

    // Aviso al usuario
    await bot.telegram.sendMessage(
      r.telegram_id,
      `Tu retiro de ${Number(r.monto).toFixed(2)} USDT fue APROBADO`
    );
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Retiro #${rid} aprobado.`);

    // --- Aviso al canal de pagos ---
const channelId = process.env.PAYMENT_CHANNEL_ID; // <-- SIN Number()
if (channelId) {
  const txt =
    '📢 Nuevo RETIRO aprobado\n\n' +
    `👤 Usuario: ${r.telegram_id}\n` +
    `💸 Monto: ${Number(r.monto).toFixed(2)} USDT\n` +
    '✅ Estado: Aprobado';

  try {
    await bot.telegram.sendMessage(channelId, txt);
  } catch (err) {
    console.log('No se pudo mandar al canal de pagos:', err?.message || err);
  }
}
  } catch (e) {
    console.log(e);
  }
});

bot.action(/ret:reject:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);

    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r) return ctx.answerCbQuery('No encontrado');
    if (r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const car = await carteraDe(r.telegram_id);
    await actualizarCartera(r.telegram_id, {
      saldo: Number(car.saldo || 0) + Number(r.monto || 0),
    });

    await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);

    try {
      await bot.telegram.sendMessage(r.telegram_id, 'Tu retiro fue RECHAZADO. Monto devuelto.');
      await ctx.editMessageReplyMarkup();
      await ctx.reply(`Retiro #${rid} rechazado y monto devuelto.`);
    } catch (e2) {
      console.log(e2);
    }
  } catch (e) {
    console.log(e);
  }
});

// ======== Utilidad: ver el chat_id del chat actual ========
bot.command('aqui', async (ctx) => {
  const cid = ctx.chat && ctx.chat.id;
  await ctx.reply('chat_id: ' + cid);
});

// =================== HTTP endpoints ===================
app.get('/', (_req, res) => res.send('FortunaMoney bot OK'));
app.get('/health', (_req, res) => res.send('OK'));

// Cron: ejecutar pago diario con ?key=CRON_SECRET (llamar a las 12:00 Europe/Madrid)
app.get('/run-pago', async (req, res) => {
  const key = req.query.key || '';
  if (key !== CRON_SECRET) return res.status(403).send('Forbidden');
  const n = await pagarDiario();
  res.send('Pago diario ejecutado. Usuarios pagados: ' + n);
});

// === Webhook de Telegram (con LOG) ===
const webhookPath = `/webhook/${BOT_TOKEN}`;

// GET de prueba
app.get(webhookPath, (_req, res) => res.status(200).send('OK'));

// Handler REAL del webhook
app.post(webhookPath, (req, res) => {
  try {
    console.log('>> Update recibido:', JSON.stringify(req.body));
  } catch (_) {}
  return bot.webhookCallback(webhookPath)(req, res);
});

// ===== Arranque (Webhook si hay HOST_URL; si no, polling local) =====
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




















































