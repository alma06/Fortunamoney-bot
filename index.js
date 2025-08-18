// ================== FortunaMoney Bot (COMPLETO con bono 10% FIX) ==================
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
const bot = new Telegraf(BOT_TOKEN, { telegram: { webhookReply: true } });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ======== Estado en memoria ========
const estado = {}; // valores: 'INV_USDT' | 'INV_CUP' | 'RET'

// ======== Helpers ========
function numero(x) { return Number(x ?? 0) || 0; }
function menu() {
  return Markup.keyboard([['Invertir'], ['Retirar'], ['Saldo'], ['Referidos']]).resize();
}
function top500(bruto) { return numero(bruto) * 5; }
function progreso500({ saldo, bono, bruto }) {
  const top = top500(bruto);
  if (top <= 0) return 0;
  return ((numero(saldo) + numero(bono)) / top) * 100;
}

async function asegurarUsuario(telegram_id, referido_por = null) {
  const { data: u } = await supabase.from('usuarios')
    .select('telegram_id, patrocinador_id')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (!u) {
    await supabase.from('usuarios').insert([{ telegram_id, patrocinador_id: referido_por || null }]);
  } else if (!u.patrocinador_id && referido_por) {
    await supabase.from('usuarios').update({ patrocinador_id: referido_por }).eq('telegram_id', telegram_id);
  }

  const { data: c } = await supabase.from('carteras')
    .select('telegram_id')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (!c) {
    await supabase.from('carteras').insert([{
      telegram_id, saldo: 0, principal: 0, bruto: 0, bono: 0
    }]);
  }
}

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

// ======== Start & Referidos ========
bot.start(async (ctx) => {
  try {
    const uid = ctx.from.id;
    let sponsor = null;
    const payload = ctx.startPayload || '';
    const m = payload.match(/^ref_(\d{5,})$/i);
    if (m) {
      sponsor = Number(m[1]);
      if (sponsor === uid) sponsor = null;
    }
    await asegurarUsuario(uid, sponsor);
    await ctx.reply('¡Bienvenido a FortunaMoney! Usa el menú 👇', menu());
  } catch (e) { console.log('START error:', e); }
});

bot.hears('Referidos', async (ctx) => {
  const uid = ctx.from.id;
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
  await ctx.reply(`Tu enlace de referido:\n${link}`);
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
    try { await ctx.reply('Error obteniendo tu saldo.'); } catch {}
  }
});

// ======== Aprobar Depósito (con bono 10%) ========
bot.action(/dep:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const depId = Number(ctx.match[1]);
    const { data: d } = await supabase.from('depositos').select('*').eq('id', depId).single();
    if (!d || d.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const carPrev = await carteraDe(d.telegram_id);
    const montoNeto = numero(d.monto) * 0.90;
    const nuevoPrincipal = carPrev.principal + montoNeto;
    const nuevoBruto     = carPrev.bruto     + numero(d.monto);

    await actualizarCartera(d.telegram_id, { principal: nuevoPrincipal, bruto: nuevoBruto });
    await supabase.from('depositos').update({ estado: 'aprobado' }).eq('id', depId);

    // ===== PAGO DE REFERIDO (10%) =====
    const { data: u } = await supabase.from('usuarios')
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
            `🎉 Bono de referido acreditado: ${bonoFinal.toFixed(2)} USDT\nPor el depósito de tu referido ${d.telegram_id}.`
          );
        } catch {}
      }
    }

    await bot.telegram.sendMessage(
      d.telegram_id,
      `✅ Depósito aprobado: ${numero(d.monto).toFixed(2)} USDT.\n` +
      `A tu principal se acreditó: ${montoNeto.toFixed(2)} USDT.\n` +
      `Bruto (base 500%): ${nuevoBruto.toFixed(2)} USDT.`
    );
    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Depósito aprobado: ${numero(d.monto).toFixed(2)} USDT`);

  } catch (e) { console.log(e); }
});

// ======== Webhook & Server ========
app.get('/', (_, res) => res.send('OK'));
app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => bot.handleUpdate(req.body, res));
app.listen(PORT, async () => {
  console.log(`HTTP server on port ${PORT}`);
  try {
    const url = `${HOST_URL}/webhook/${WEBHOOK_SECRET}`;
    await bot.telegram.setWebhook(url);
    console.log(`Webhook configurado en: ${url}`);
  } catch (e) { console.log('setWebhook error:', e); }
});
