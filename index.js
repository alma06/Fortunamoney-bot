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

// URL pública de tu app (Render): p.ej. https://tu-app.onrender.com
const HOST_URL       = process.env.HOST_URL || '';
// Clave para proteger el endpoint de cron /run-pago
const CRON_SECRET    = process.env.CRON_SECRET || 'cambia_esto';

// Puerto (Render lo inyecta en process.env.PORT)
const PORT = process.env.PORT || 3000;

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

async function patrocinadorDe(id) {
  const { data } = await supabase.from('referidos')
    .select('patrocinador_id').eq('referido_id', id).single();
  return data ? data.patrocinador_id : null;
}

async function registrarReferencia(patroId, referidoId) {
  if (!patroId || !referidoId || patroId === referidoId) return;
  const { data } = await supabase.from('referidos')
    .select('id').eq('referido_id', referidoId).single();
  if (!data) await supabase.from('referidos').insert([{ patrocinador_id: patroId, referido_id: referidoId }]);
}

// ======== Avisos admin/grupo ========
async function avisarAdmin(msg) {
  try {
    if (ADMIN_GROUP_ID) await bot.telegram.sendMessage(ADMIN_GROUP_ID, msg);
    else if (ADMIN_ID)   await bot.telegram.sendMessage(ADMIN_ID, msg);
  } catch (e) {
    console.log('No pude avisar a admin:', e.message || e);
  }
}

// ======== Finanzas ========
function tasaSegunBruto(brutoTotal) { return brutoTotal >= 500 ? 0.02 : 0.015; }
function brutoDesdeNeto(neto) { return neto > 0 ? (neto / 0.9) : 0; }
function tope500Bruto(bruto) { return bruto * 5.0; }

// ======== Handlers Bot ========
bot.start(async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    // Soporte de referidos: /start ref_12345
    const text = ctx.message.text || '';
    const partes = text.split(' ');
    if (partes.length > 1) {
      const arg = partes[1];
      if (arg.indexOf('ref_') === 0) {
        const patroId = Number(arg.replace('ref_', ''));
        if (patroId && patroId !== chatId) await registrarReferencia(patroId, chatId);
      }
    }

    await ctx.reply('Bienvenido. Usa el menú:', menu());
  } catch (e) {
    console.log(e);
    try { await ctx.reply('Ocurrió un error al iniciar.'); } catch {}
  }
});

bot.hears('Invertir', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    estado[chatId] = 'INV';
    await ctx.reply('Escribe el monto a invertir (solo número, ejemplo: 100.00)');
  } catch (e) { console.log(e); }
});

bot.hears('Retirar', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    const car = await carteraDe(chatId);
    await ctx.reply(
      'Tu saldo disponible es: ' + Number(car.saldo || 0).toFixed(2) +
      '\nEscribe el monto a retirar (solo número, ejemplo: 25.00)'
    );
    estado[chatId] = 'RET';
  } catch (e) { console.log(e); }
});

bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);
    const car = await carteraDe(chatId);

    const invertidoNeto = Number(car.invertido || 0);
    const disponible     = Number(car.saldo || 0);
    const bruto          = brutoDesdeNeto(invertidoNeto);
    const retirado       = await totalRetirado(chatId);
    const tope           = tope500Bruto(bruto);
    const pagadoHastaAhora = disponible + retirado;
    const progreso       = tope > 0 ? Math.min(100, (pagadoHastaAhora / tope) * 100) : 0;

    await ctx.reply(
      'Tu saldo:' +
      '\n- Principal (invertido): ' + invertidoNeto.toFixed(2) +
      '\n- Disponible: ' + disponible.toFixed(2) +
      '\n- Total: ' + invertidoNeto.toFixed(2) +
      '\n' +
      '\nBruto (base para 500%): ' + bruto.toFixed(2) +
      '\nProgreso hacia 500%: ' + progreso.toFixed(2) + '%'
    );
  } catch (e) { console.log(e); }
});

bot.hears('Referidos', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const enlace = 'https://t.me/' + (ctx.botInfo.username || 'Fortunamoneybot') + '?start=ref_' + chatId;
    await ctx.reply(
      'Tu enlace de referido:\n' + enlace +
      '\nGanas 10% de cada inversión de tu referido (retirable). Ese 10% cuenta hacia el 500%.'
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

// Texto (captura flujos de invertir/retirar)
bot.on('text', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    const txt = (ctx.message.text || '').trim();
    if (txt.startsWith('/')) return; // no comerse comandos

    // Invertir
    if (estado[chatId] === 'INV') {
      const monto = Number(txt.replace(',', '.'));
      if (isNaN(monto) || monto <= 0) {
        await ctx.reply('Monto inválido. Intenta de nuevo.');
        return;
      }
      await asegurarUsuario(chatId);

      const ins = await supabase.from('depositos').insert([{
        telegram_id: chatId,
        monto: monto,
        estado: 'pendiente'
      }]).select('id').single();

      if (ins.error) {
        console.log(ins.error);
        await ctx.reply('No se pudo crear el depósito. Intenta nuevamente.');
        estado[chatId] = undefined;
        return;
      }

      const depId = ins.data.id;
      await avisarAdmin(
        'Nuevo DEPÓSITO pendiente\n' +
        'ID: ' + depId + '\n' +
        'User: ' + chatId + '\n' +
        'Monto: ' + monto.toFixed(2) + ' USDT'
      );

      await ctx.reply(
        'Depósito creado (pendiente).\n' +
        'ID: ' + depId + '\n' +
        'Monto: ' + monto.toFixed(2) + ' USDT\n\n' +
        'Envía el monto a esta wallet:\n' + WALLET_USDT + '\n\n' +
        '👉 Envía el hash con: /tx ' + depId + ' TU_HASH_AQUI\n' +
        '📷 Y envía una foto/captura del pago en este chat.\n\n' +
        'Cuando el admin confirme la recepción, tu inversión será acreditada.'
      );

      estado[chatId] = undefined;
      await ctx.reply('Menú:', menu());
      return;
    }

    // Retirar
    if (estado[chatId] === 'RET') {
      const monto = Number(txt.replace(',', '.'));
      if (isNaN(monto) || monto <= 0) {
        await ctx.reply('Monto inválido. Intenta de nuevo.');
        return;
      }
      await asegurarUsuario(chatId);
      const car = await carteraDe(chatId);
      const disp = Number(car.saldo || 0);

      if (monto > disp) {
        await ctx.reply('Monto supera tu saldo disponible (' + disp.toFixed(2) + '). Escribe otro monto.');
        return;
      }

      await actualizarCartera(chatId, { saldo: disp - monto });
      const insR = await supabase.from('retiros').insert([
        { telegram_id: chatId, monto: monto, estado: 'pendiente' }
      ]).select('id').single();

      await ctx.reply('Retiro solicitado por ' + monto.toFixed(2) + ' USDT. Estado: pendiente.');
      estado[chatId] = undefined;
      await ctx.reply('Menú:', menu());

      if (insR && insR.data) {
        const rid = insR.data.id;
        await avisarAdmin(
          'Nuevo RETIRO pendiente\n' +
          'ID: ' + rid + '\n' +
          'User: ' + chatId + '\n' +
          'Monto: ' + monto.toFixed(2) + ' USDT'
        );
      }
      return;
    }
  } catch (e) {
    console.log(e);
    try { await ctx.reply('Ocurrió un error.'); } catch {}
  }
});

// Foto: guarda comprobante en depósito más reciente pendiente
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
  } catch (e) { console.log(e); }
});

// /tx: guarda hash en un depósito pendiente del usuario
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
});

// ======== ADMIN – Depósitos ========
bot.command('pendientes', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const { data, error } = await supabase.from('depositos')
    .select('id, telegram_id, monto, creado_en, tx, proof_file_id')
    .eq('estado', 'pendiente').order('id', { ascending: true });
  if (error) return ctx.reply('Error listando pendientes.');
  if (!data || data.length === 0) return ctx.reply('Sin depósitos pendientes.');
  let msg = 'Depósitos pendientes:\n';
  data.forEach(d => {
    msg += '#' + d.id +
      ' | user ' + d.telegram_id +
      ' | ' + Number(d.monto).toFixed(2) + ' USDT' +
      ' | hash: ' + (d.tx ? '✔' : '—') +
      ' | foto: ' + (d.proof_file_id ? '✔' : '—') +
      '\n';
  });
  await ctx.reply(msg);
});

bot.command('verfoto', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Uso: /verfoto <id_deposito>');
  const depId = Number(parts[1]);

  const { data: dep } = await supabase.from('depositos')
    .select('proof_file_id').eq('id', depId).single();
  if (!dep) return ctx.reply('Depósito no encontrado.');
  if (!dep.proof_file_id) return ctx.reply('Ese depósito no tiene foto.');

  try { await ctx.replyWithPhoto(dep.proof_file_id); }
  catch (e) { console.log(e); await ctx.reply('No pude enviar la foto (file_id inválido).'); }
});

bot.command('aprobar', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Uso: /aprobar <id_deposito>');
  const depId = Number(parts[1]);

  const { data: dep } = await supabase.from('depositos').select('*').eq('id', depId).single();
  if (!dep) return ctx.reply('Depósito no encontrado.');
  if (dep.estado !== 'pendiente') return ctx.reply('Ese depósito no está pendiente.');

  const userId = dep.telegram_id;
  const monto  = Number(dep.monto);
  const comision = monto * 0.10;
  const principalNeto = monto - comision;

  await asegurarUsuario(userId);

  const patroId = await patrocinadorDe(userId);
  const carU = await carteraDe(userId);
  await actualizarCartera(userId, { invertido: Number(carU.invertido || 0) + principalNeto });

  if (patroId) {
    await asegurarUsuario(patroId);
    const carP = await carteraDe(patroId);
    await actualizarCartera(patroId, { saldo: Number(carP.saldo || 0) + comision });
  }

  await supabase.from('depositos').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', depId);

  try {
    await bot.telegram.sendMessage(
      userId,
      'Depósito aprobado: ' + monto.toFixed(2) + ' USDT.\n' +
      'A tu principal se acreditó: ' + principalNeto.toFixed(2) + ' USDT.'
    );
  } catch {}

  await ctx.reply(
    'Aprobado #' + depId + ' | user ' + userId +
    ' | monto ' + monto.toFixed(2) +
    ' | sponsor 10% ' + comision.toFixed(2) +
    ' | principal neto ' + principalNeto.toFixed(2)
  );
});

bot.command('rechazar', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Uso: /rechazar <id_deposito>');
  const depId = Number(parts[1]);

  const { data: dep } = await supabase.from('depositos').select('estado').eq('id', depId).single();
  if (!dep) return ctx.reply('Depósito no encontrado.');
  if (dep.estado !== 'pendiente') return ctx.reply('Solo se puede rechazar si está pendiente.');

  await supabase.from('depositos').update({ estado: 'rechazado' }).eq('id', depId);
  await ctx.reply('Depósito #' + depId + ' rechazado.');
});

// ======== ADMIN – Retiros ========
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

bot.command('aprobarretiro', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Uso: /aprobarretiro <id_retiro>');
  const rid = Number(parts[1]);

  const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
  if (!r) return ctx.reply('Retiro no encontrado.');
  if (r.estado !== 'pendiente') return ctx.reply('Ese retiro no está pendiente.');

  await supabase.from('retiros').update({ estado: 'aprobado', aprobado_en: new Date().toISOString() }).eq('id', rid);

  try { await bot.telegram.sendMessage(r.telegram_id, 'Tu retiro de ' + Number(r.monto).toFixed(2) + ' USDT fue APROBADO.'); } catch {}
  await ctx.reply('Retiro #' + rid + ' aprobado.');
});

bot.command('rechazarretiro', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ctx.chat.id !== ADMIN_GROUP_ID) return;
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('Uso: /rechazarretiro <id_retiro>');
  const rid = Number(parts[1]);

  const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
  if (!r) return ctx.reply('Retiro no encontrado.');
  if (r.estado !== 'pendiente') return ctx.reply('Ese retiro no está pendiente.');

  const car = await carteraDe(r.telegram_id);
  await actualizarCartera(r.telegram_id, { saldo: Number(car.saldo || 0) + Number(r.monto || 0) });

  await supabase.from('retiros').update({ estado: 'rechazado' }).eq('id', rid);

  try { await bot.telegram.sendMessage(r.telegram_id, 'Tu retiro de ' + Number(r.monto).toFixed(2) + ' USDT fue RECHAZADO. Monto devuelto.'); } catch {}
  await ctx.reply('Retiro #' + rid + ' rechazado y monto devuelto.');
});

// ======== Utilidad: ver el chat_id del chat actual ========
bot.command('aqui', async (ctx) => {
  const cid = ctx.chat?.id;
  await ctx.reply('chat_id: ' + cid);
});

// =================== HTTP endpoints ===================

// Salud
app.get('/', (_req, res) => res.send('FortunaMoney bot OK'));
app.get('/health', (_req, res) => res.send('OK'));

// Cron: ejecutar pago diario con ?key=CRON_SECRET (llamar a las 12:00 Europe/Madrid)
app.get('/run-pago', async (req, res) => {
  const key = req.query.key || '';
  if (key !== CRON_SECRET) return res.status(403).send('Forbidden');
  const n = await pagarDiario();
  res.send('Pago diario ejecutado. Usuarios pagados: ' + n);
});

// Webhook de Telegram
const webhookPath = '/webhook/' + BOT_TOKEN;
app.use(webhookPath, (req, res) => bot.webhookCallback(webhookPath)(req, res));

// ======== Arranque (Webhook si hay HOST_URL; si no, polling local) ========
app.listen(PORT, async () => {
  console.log('HTTP server on port', PORT);

  try {
    if (HOST_URL) {
      const url = HOST_URL + webhookPath;
      await bot.telegram.setWebhook(url);
      console.log('Webhook configurado en:', url);
    } else {
      // Modo local (desarrollo): long polling
      await bot.launch();
      console.log('Bot lanzado en modo polling (HOST_URL no definido).');
    }
  } catch (e) {
    console.log('Error configurando webhook/polling:', e.message || e);
  }
});

// Cierre limpio
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));