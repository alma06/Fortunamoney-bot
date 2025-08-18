// ================== FortunaMoney Bot (COMPLETO con bono 10% y botones OK) ==================
require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
// Draft temporal para retiros (monto + método + luego destino)
const retiroDraft = globalThis.retiroDraft || (globalThis.retiroDraft = {});

// ======== ENV ========
const BOT_TOKEN       = process.env.BOT_TOKEN;
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const ADMIN_ID        = Number(process.env.ADMIN_ID || 0);
const ADMIN_GROUP_ID  = Number(process.env.ADMIN_GROUP_ID || 0);
const PAYMENT_CHANNEL = Number(process.env.PAYMENT_CHANNEL || 0);
const WALLET_USDT     = process.env.WALLET_USDT || 'WALLET_NO_CONFIGURADA';
const WALLET_CUP      = process.env.WALLET_CUP  || 'TARJETA_NO_CONFIGURADA';
const HOST_URL        = process.env.HOST_URL || ''; // https://tu-app.onrender.com
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || 'secret';
const PORT            = Number(process.env.PORT || 3000);

// Reglas
const MIN_INVERSION    = Number(process.env.MIN_INVERSION || 25);  // USDT
const RETIRO_FEE_USDT  = Number(process.env.RETIRO_FEE_USDT || 1);
const CUP_USDT_RATE    = Number(process.env.CUP_USDT_RATE  || 400); // 1 USDT = 400 CUP

// Validar variables de entorno obligatorias
const requiredEnvVars = {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_KEY,
  ADMIN_ID,
  ADMIN_GROUP_ID,
  HOST_URL
};

const missingVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value || value === 0)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('❌ Faltan variables de entorno obligatorias:', missingVars.join(', '));
  console.error('📋 Variables actuales:');
  console.error('- BOT_TOKEN:', BOT_TOKEN ? '✅ Configurado' : '❌ Faltante');
  console.error('- SUPABASE_URL:', SUPABASE_URL ? '✅ Configurado' : '❌ Faltante');
  console.error('- SUPABASE_KEY:', SUPABASE_KEY ? '✅ Configurado' : '❌ Faltante');
  console.error('- ADMIN_ID:', ADMIN_ID ? '✅ Configurado' : '❌ Faltante');
  console.error('- ADMIN_GROUP_ID:', ADMIN_GROUP_ID ? '✅ Configurado' : '❌ Faltante');
  console.error('- PAYMENT_CHANNEL:', PAYMENT_CHANNEL ? '✅ Configurado' : '⚠️ No configurado (opcional)');
  console.error('- HOST_URL:', HOST_URL ? '✅ Configurado' : '❌ Faltante');
  process.exit(1);
}

// Advertir sobre variables opcionales
if (!PAYMENT_CHANNEL) {
  console.warn('⚠️ PAYMENT_CHANNEL no configurado. Las notificaciones de retiros no se enviarán al canal público.');
}

// ======== INIT con mejor manejo de errores ========
const bot = new Telegraf(BOT_TOKEN, { telegram: { webhookReply: true } });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Verificar conexión con Telegram al inicio
bot.telegram.getMe().then(botInfo => {
  console.log('✅ Conectado a Telegram como:', botInfo.username);
}).catch(error => {
  console.error('❌ Error conectando con Telegram:', error?.message || error);
  process.exit(1);
});

// Verificar conexión con Supabase al inicio
supabase.from('usuarios').select('count').limit(1).then(() => {
  console.log('✅ Conectado a Supabase');
}).catch(error => {
  console.error('❌ Error conectando con Supabase:', error?.message || error);
  process.exit(1);
});

// Estado para tracking de conversaciones
const estado = {};

// ======== Funciones para Tasa Diaria Dinámica ========
async function obtenerPorcentajeDelDia() {
  try {
    const { data, error } = await supabase
      .from('tasa_diaria')
      .select('porcentaje')
      .order('fecha', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (error) {
      console.log('Error obteniendo tasa diaria:', error);
      return 1; // Default 1%
    }
    
    return data ? numero(data.porcentaje) : 1; // Default 1%
  } catch (e) {
    console.log('Error en obtenerPorcentajeDelDia:', e);
    return 1; // Default 1%
  }
}

async function establecerPorcentajeDelDia(porcentaje) {
  try {
    const { error } = await supabase
      .from('tasa_diaria')
      .insert([{
        porcentaje: numero(porcentaje),
        fecha: new Date().toISOString()
      }]);
    
    if (error) {
      console.log('Error estableciendo tasa diaria:', error);
      return false;
    }
    
    return true;
  } catch (e) {
    console.log('Error en establecerPorcentajeDelDia:', e);
    return false;
  }
}

async function notificarNuevaTasa(porcentaje) {
  try {
    // Obtener todos los usuarios activos (con inversiones aprobadas)
    const { data: usuarios } = await supabase
      .from('depositos')
      .select('telegram_id')
      .eq('estado', 'aprobado');
    
    if (!usuarios || !usuarios.length) return;
    
    // Crear lista única de usuarios
    const usuariosUnicos = [...new Set(usuarios.map(u => Number(u.telegram_id)))];
    
    const mensaje = `📊 Tasa del día: ${porcentaje}% - ¡Prepárate para tus ganancias!`;
    
    let notificados = 0;
    for (const userId of usuariosUnicos) {
      try {
        await bot.telegram.sendMessage(userId, mensaje);
        notificados++;
        // Pequeña pausa para evitar rate limits
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (e) {
        console.log(`No se pudo notificar a ${userId}:`, e?.message || e);
      }
    }
    
    console.log(`Notificación de tasa enviada a ${notificados} usuarios`);
    return notificados;
  } catch (e) {
    console.log('Error en notificarNuevaTasa:', e);
    return 0;
  }
}

// ======== Helpers ========
function numero(x) { return Number(x ?? 0) || 0; }
function menu() {
  return Markup.keyboard([
    ['Invertir'],
    ['Retirar'],
    ['Saldo'],
    ['Referidos'],
    ['Ganado total']
  ]).resize();
}

// === NUEVAS FUNCIONES PARA INVERSIONES INDIVIDUALES ===

// Obtener todas las inversiones activas de un usuario
async function inversionesDe(telegram_id, incluirBonos = true) {
  let query = supabase
    .from('depositos')
    .select('*')
    .eq('telegram_id', telegram_id)
    .eq('estado', 'aprobado');
    
  // Si no queremos incluir bonos, filtrarlos
  if (!incluirBonos) {
    query = query.neq('es_bono_referido', true);
  }
  
  const { data } = await query.order('id', { ascending: true });
  
  return data || [];
}

// Calcular saldos totales por moneda
async function saldosPorMoneda(telegram_id) {
  const inversiones = await inversionesDe(telegram_id);
  const saldos = { USDT: 0, CUP: 0 };
  
  for (const inv of inversiones) {
    const disponible = numero(inv.ganado_disponible);
    saldos[inv.moneda] = (saldos[inv.moneda] || 0) + disponible;
  }
  
  return saldos;
}

// Verificar si una inversión alcanzó el tope 500% (considerando acelerador)
function topeAlcanzado(inversion) {
  const montoBase = numero(inversion.monto_origen);
  const acelerador = numero(inversion.acelerador_usado) || 0;
  const tope = montoBase * 5 - acelerador; // Tope reducido por acelerador
  const ganado = numero(inversion.ganado_total);
  return ganado >= tope;
}

// Calcular progreso al 500% de una inversión (considerando acelerador)
function progresoInversion(inversion) {
  const montoBase = numero(inversion.monto_origen);
  const acelerador = numero(inversion.acelerador_usado) || 0;
  const tope = montoBase * 5 - acelerador; // Tope reducido por acelerador
  const ganado = numero(inversion.ganado_total);
  return tope > 0 ? (ganado / tope) * 100 : 0;
}

// Aplicar acelerador de bono de referido a las inversiones del sponsor
async function aplicarAceleradorBono(sponsorId, bonoMonto, moneda) {
  try {
    // Obtener todas las inversiones activas del sponsor en la misma moneda (sin bonos)
    const { data: inversiones } = await supabase
      .from('depositos')
      .select('*')
      .eq('telegram_id', sponsorId)
      .eq('estado', 'aprobado')
      .eq('moneda', moneda)
      .neq('es_bono_referido', true); // Excluir bonos de referido

    if (!inversiones || inversiones.length === 0) {
      console.log(`[ACELERADOR] ${sponsorId} no tiene inversiones activas en ${moneda}`);
      return;
    }

    // Filtrar solo inversiones que no han alcanzado el tope
    const inversionesActivas = inversiones.filter(inv => !topeAlcanzado(inv));
    
    if (inversionesActivas.length === 0) {
      console.log(`[ACELERADOR] ${sponsorId} no tiene inversiones sin alcanzar tope en ${moneda}`);
      return;
    }

    // Distribuir el bono equitativamente
    const bonoPorInversion = bonoMonto / inversionesActivas.length;

    for (const inv of inversionesActivas) {
      const aceleradorActual = numero(inv.acelerador_usado) || 0;
      const nuevoAcelerador = aceleradorActual + bonoPorInversion;

      await supabase.from('depositos')
        .update({ acelerador_usado: nuevoAcelerador })
        .eq('id', inv.id);

      console.log(`[ACELERADOR] Inv #${inv.id}: +${bonoPorInversion.toFixed(2)} ${moneda}, total acelerador: ${nuevoAcelerador.toFixed(2)}`);
    }

    console.log(`[ACELERADOR] Distribuidos ${bonoMonto} ${moneda} entre ${inversionesActivas.length} inversiones de ${sponsorId}`);
  } catch (e) {
    console.log('[ACELERADOR] Error aplicando acelerador:', e);
  }
}

// Crear sin pisar valores existentes; setear patrocinador si estaba vacío
async function asegurarUsuario(telegram_id, referido_por = null) {
  // usuarios
  const { data: u } = await supabase
    .from('usuarios')
    .select('telegram_id, patrocinador_id')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (!u) {
    await supabase.from('usuarios').insert([{ telegram_id, patrocinador_id: referido_por || null }]);
  } else if (!u.patrocinador_id && referido_por) {
    await supabase.from('usuarios').update({ patrocinador_id: referido_por }).eq('telegram_id', telegram_id);
  }
}

// === FUNCIONES PARA BONOS (mantienen tabla carteras para bonos de referidos) ===
async function carteraBonosDe(telegram_id) {
  const { data } = await supabase
    .from('carteras')
    .select('saldo, bono, ganado_total')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  return {
    saldo:         numero(data?.saldo),
    bono:          numero(data?.bono),
    ganado_total:  numero(data?.ganado_total)
  };
}

async function actualizarCarteraBonos(telegram_id, patch) {
  const cur = await carteraBonosDe(telegram_id);
  
  // Asegurar que existe la cartera de bonos
  const { data: existe } = await supabase
    .from('carteras')
    .select('telegram_id')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (!existe) {
    await supabase.from('carteras').insert([{
      telegram_id, saldo: 0, principal: 0, bruto: 0, bono: 0, ganado_total: 0
    }]);
  }

  const row = {
    telegram_id,
    saldo:        (patch.saldo        !== undefined) ? numero(patch.saldo)        : cur.saldo,
    bono:         (patch.bono         !== undefined) ? numero(patch.bono)         : cur.bono,
    ganado_total: (patch.ganado_total !== undefined) ? numero(patch.ganado_total) : cur.ganado_total
  };
  
  await supabase.from('carteras').upsert([row], { onConflict: 'telegram_id' });
}


// ======== /start & Referidos ========
bot.start(async (ctx) => {
  try {
    const uid = ctx.from.id;
    let sponsor = null;
    const payload = ctx.startPayload || '';  // soporta /start ref_XXXX
    const m = payload.match(/^ref_(\d{5,})$/i);
    if (m) {
      sponsor = Number(m[1]);
      if (sponsor === uid) sponsor = null; // no auto-referido
    }
    await asegurarUsuario(uid, sponsor);
    
    const welcomeMsg = sponsor 
      ? '🎉 ¡Bienvenido a FortunaMoney! Has sido referido por otro usuario.\n\n📋 Usa el menú de abajo para comenzar a invertir y generar ganancias diarias.\n\n💡 Tip: Si no ves el menú, usa /menu para mostrarlo.'
      : '🎉 ¡Bienvenido a FortunaMoney!\n\n📋 Usa el menú de abajo para comenzar a invertir y generar ganancias diarias.\n\n� Tip: Si no ves el menú, usa /menu para mostrarlo.';
    
    await ctx.reply(welcomeMsg, menu());
  } catch (e) { console.log('START error:', e); }
});

bot.hears('Referidos', async (ctx) => {
  const uid = ctx.from.id;
  const link = `https://t.me/${ctx.botInfo.username}?start=ref_${uid}`;
  await ctx.reply(`Tu enlace de referido:\n${link}`);
});

// ======== Comando /menu ========
bot.command('menu', async (ctx) => {
  await ctx.reply('📋 Aquí tienes el menú principal:', menu());
});

// ======== Comando /ayuda o /help ========
bot.command(['ayuda', 'help'], async (ctx) => {
  const helpText = 
    '🆘 **AYUDA - FortunaMoney Bot**\n\n' +
    '📋 **Opciones del menú:**\n' +
    '• **Invertir** - Realiza un depósito en USDT o CUP\n' +
    '• **Retirar** - Solicita un retiro de tus ganancias\n' +
    '• **Saldo** - Consulta tu balance actual\n' +
    '• **Referidos** - Obtén tu enlace de referido\n' +
    '• **Ganado total** - Ve tu histórico de ganancias\n\n' +
    '💰 **Información importante:**\n' +
    '• Inversión mínima: 25 USDT o 500 CUP\n' +
    '• Ganancias diarias: Tasa dinámica (consulta /porcentajehoy)\n' +
    '• Tope máximo: 500% de tu inversión inicial\n' +
    '• Bono por referidos: 10% del depósito\n\n' +
    '🚀 **Sistema de Acelerador:**\n' +
    '• Los bonos de referidos actúan como "acelerador"\n' +
    '• Se distribuyen entre todas tus inversiones activas\n' +
    '• Reducen el tope del 500% de cada inversión\n' +
    '• Te permiten alcanzar el límite más rápido\n\n' +
    '🔧 **Comandos útiles:**\n' +
    '• /start - Reiniciar el bot\n' +
    '• /menu - Mostrar el menú\n' +
    '• /ayuda - Mostrar esta ayuda\n' +
    '• /porcentajehoy - Ver la tasa del día\n\n' +
    '📞 **¿Necesitas soporte?** Contacta con el administrador.';
  
  await ctx.reply(helpText, { parse_mode: 'Markdown', ...menu() });
});

// ======== Saldo ========
bot.hears('Saldo', async (ctx) => {
  try {
    const chatId = ctx.from.id;
    await asegurarUsuario(chatId);

    // Obtener inversiones individuales (sin bonos) y bonos por separado
    const inversiones = await inversionesDe(chatId, false); // Sin bonos
    const bonosInversion = await inversionesDe(chatId, true); // Con bonos, luego filtraremos
    const saldos = await saldosPorMoneda(chatId);
    const bonos = await carteraBonosDe(chatId);

    // Separar bonos de inversiones
    const soloInversiones = bonosInversion.filter(inv => !inv.es_bono_referido);
    const soloBonos = bonosInversion.filter(inv => inv.es_bono_referido);

    if (!soloInversiones.length && bonos.saldo <= 0 && !soloBonos.length) {
      return ctx.reply(
        '📊 **Tu estado actual:**\n\n' +
        '💰 No tienes inversiones activas.\n' +
        `💎 No tienes bonos disponibles.\n\n` +
        '¡Comienza a invertir para generar ganancias diarias!',
        { parse_mode: 'Markdown', ...menu() }
      );
    }

    let mensaje = '📊 **Tus Inversiones:**\n\n';

    // Agrupar por moneda solo las inversiones reales
    const porMoneda = { USDT: [], CUP: [] };
    for (const inv of soloInversiones) {
      porMoneda[inv.moneda].push(inv);
    }

    // Mostrar USDT
    if (porMoneda.USDT.length > 0) {
      mensaje += '💵 **USDT:**\n';
      for (const inv of porMoneda.USDT) {
        const progreso = progresoInversion(inv);
        const disponible = numero(inv.ganado_disponible);
        const acelerador = numero(inv.acelerador_usado) || 0;
        mensaje += `  • Inv #${inv.id}: ${numero(inv.monto_origen).toFixed(2)} USDT\n`;
        mensaje += `    Disponible: ${disponible.toFixed(2)} USDT\n`;
        mensaje += `    Progreso: ${progreso.toFixed(1)}%\n`;
        if (acelerador > 0) {
          mensaje += `    🚀 Acelerador: ${acelerador.toFixed(2)} USDT\n`;
        }
      }
      mensaje += `  🟢 **Total USDT: ${saldos.USDT.toFixed(2)}**\n\n`;
    }

    // Mostrar CUP
    if (porMoneda.CUP.length > 0) {
      mensaje += '💰 **CUP:**\n';
      for (const inv of porMoneda.CUP) {
        const progreso = progresoInversion(inv);
        const disponible = numero(inv.ganado_disponible);
        const acelerador = numero(inv.acelerador_usado) || 0;
        mensaje += `  • Inv #${inv.id}: ${numero(inv.monto_origen).toFixed(0)} CUP\n`;
        mensaje += `    Disponible: ${disponible.toFixed(0)} CUP\n`;
        mensaje += `    Progreso: ${progreso.toFixed(1)}%\n`;
        if (acelerador > 0) {
          mensaje += `    🚀 Acelerador: ${acelerador.toFixed(0)} CUP\n`;
        }
      }
      mensaje += `  🟢 **Total CUP: ${saldos.CUP.toFixed(0)}**\n\n`;
    }

    // Mostrar bonos de referidos
    let tieneBonosUSDT = bonos.saldo > 0;
    let tieneBonosCUP = false;
    let totalBonosCUP = 0;

    for (const bono of soloBonos) {
      if (bono.moneda === 'CUP') {
        tieneBonosCUP = true;
        totalBonosCUP += numero(bono.ganado_disponible);
      }
    }

    if (tieneBonosUSDT || tieneBonosCUP) {
      mensaje += '💎 **Bonos de referidos:**\n';
      if (tieneBonosUSDT) {
        mensaje += `  • USDT: ${bonos.saldo.toFixed(2)} USDT\n`;
      }
      if (tieneBonosCUP) {
        mensaje += `  • CUP: ${totalBonosCUP.toFixed(0)} CUP\n`;
      }
      mensaje += '\n';
    }

    mensaje += '💡 *Cada inversión tiene un tope del 500%*';

    await ctx.reply(mensaje, { parse_mode: 'Markdown', ...menu() });

  } catch (e) {
    console.log('ERROR Saldo:', e);
    try { await ctx.reply('Error obteniendo tu saldo. Intenta de nuevo.'); } catch {}
  }
});

bot.hears('Ganado total', async (ctx) => {
  try {
    const uid = ctx.from.id;
    await asegurarUsuario(uid);
    
    const inversiones = await inversionesDe(uid);
    const bonos = await carteraBonosDe(uid);
    
    let totalUSDT = 0;
    let totalCUP = 0;
    
    for (const inv of inversiones) {
      const ganado = numero(inv.ganado_total);
      if (inv.moneda === 'USDT') {
        totalUSDT += ganado;
      } else {
        totalCUP += ganado;
      }
    }

    await ctx.reply(
      '📈 **Ganado total histórico:**\n\n' +
      `💵 USDT: ${totalUSDT.toFixed(2)}\n` +
      `💰 CUP: ${totalCUP.toFixed(0)}\n` +
      `💎 Bonos: ${bonos.ganado_total.toFixed(2)} USDT\n\n` +
      '*Esto incluye todo lo ganado desde el inicio.*',
      { parse_mode: 'Markdown', ...menu() }
    );
  } catch (e) {
    console.log('ERROR Ganado total:', e);
    try { await ctx.reply('Error obteniendo el ganado total. Intenta de nuevo.'); } catch {}
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
  await asegurarUsuario(chatId);
  
  const saldos = await saldosPorMoneda(chatId);
  const bonos = await carteraBonosDe(chatId);
  
  // Verificar si tiene saldos disponibles
  const tieneUSDT = saldos.USDT > 0 || bonos.saldo > 0;
  const tieneCUP = saldos.CUP > 0;
  
  if (!tieneUSDT && !tieneCUP) {
    return ctx.reply(
      '❌ No tienes saldos disponibles para retirar.\n\n' +
      'Realiza una inversión y espera a generar ganancias.',
      menu()
    );
  }
  
  let mensaje = '💰 **Saldos disponibles para retiro:**\n\n';
  const botones = [];
  
  if (tieneUSDT) {
    const totalUSDT = saldos.USDT + bonos.saldo;
    mensaje += `💵 USDT: ${totalUSDT.toFixed(2)}\n`;
    botones.push([{ text: `Retirar USDT (${totalUSDT.toFixed(2)})`, callback_data: 'ret:moneda:USDT' }]);
  }
  
  if (tieneCUP) {
    mensaje += `💰 CUP: ${saldos.CUP.toFixed(0)}\n`;
    botones.push([{ text: `Retirar CUP (${saldos.CUP.toFixed(0)})`, callback_data: 'ret:moneda:CUP' }]);
  }
  
  mensaje += '\n*Elige la moneda que deseas retirar:*';
  
  await ctx.reply(mensaje, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: botones }
  });
});

// ============== Handler ÚNICO de texto (montos) ==============
bot.on('text', async (ctx, next) => {
  try {
    const chatId = ctx.from.id;
    const txtRaw = (ctx.message?.text ?? '').trim();

    // Si es un comando tipo /algo, deja pasar a otros handlers/comandos
    if (txtRaw.startsWith('/')) return next();

    const st = estado[chatId];

    // Si NO estamos en un estado que este handler deba procesar,
    // DEJA PASAR el mensaje a los .hears() con next()
    const estadosManejados = ['INV_USDT', 'INV_CUP', 'RET_USDT', 'RET_CUP', 'RET_DEST'];
    if (!estadosManejados.includes(st)) {
      // Si no está en ningún estado específico, mostrar mensaje cordial
      await ctx.reply(
        '😊 Hola! Parece que has escrito algo que no reconozco.\n\n' +
        '📋 Por favor, utiliza las opciones del menú principal:\n' +
        '• Invertir\n' +
        '• Retirar\n' +
        '• Saldo\n' +
        '• Referidos\n' +
        '• Ganado total\n\n' +
        '💡 Si no ves el menú, escribe /start para mostrarlo nuevamente.',
        menu()
      );
      return;
    }

    const txt = txtRaw;
    const monto = Number(txt.replace(',', '.'));

    // ===== INVERTIR =====
    if (st === 'INV_USDT' || st === 'INV_CUP') {
      if (isNaN(monto) || monto <= 0) {
        await ctx.reply('Monto inválido. Solo números, ej: 50.00');
        return;
      }

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
      let montoFinal = monto;

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
        estado: 'pendiente',
        // Nuevos campos para inversiones individuales
        ganado_disponible: 0,
        ganado_total: 0,
        fecha_creacion: new Date().toISOString()
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
    if (st === 'RET_USDT' || st === 'RET_CUP') {
      if (isNaN(monto) || monto <= 0) {
        await ctx.reply('Monto inválido. Solo números, ej: 25.00');
        return;
      }

      const moneda = st === 'RET_USDT' ? 'USDT' : 'CUP';
      const saldos = await saldosPorMoneda(chatId);
      const bonos = await carteraBonosDe(chatId);
      
      let disponible = saldos[moneda];
      if (moneda === 'USDT') {
        disponible += bonos.saldo; // Incluir bonos para USDT
      }

      let fee = 0;
      let totalDebitar = monto;
      
      if (moneda === 'USDT') {
        fee = RETIRO_FEE_USDT;
        totalDebitar = monto + fee;
      }

      if (totalDebitar > disponible) {
        await ctx.reply(
          'Saldo insuficiente.\n' +
          `Disponible: ${disponible.toFixed(moneda === 'USDT' ? 2 : 0)} ${moneda}\n` +
          `Se necesita: ${totalDebitar.toFixed(moneda === 'USDT' ? 2 : 0)} ${moneda}` +
          (fee > 0 ? ` (monto + fee)` : '') + '.'
        );
        estado[chatId] = undefined;
        return;
      }

      // Guardar datos en draft
      retiroDraft[chatId] = { monto, moneda };
      await ctx.reply(
        'Elige método de cobro:',
        Markup.inlineKeyboard([
          [{ text: moneda === 'USDT' ? 'USDT (BEP20)' : 'CUP (Tarjeta)', callback_data: `ret:m:${moneda.toLowerCase()}` }]
        ])
      );

      estado[chatId] = 'RET_ELIGE_METODO';
      return;
    }

    // ===== RETIRO: captura destino (wallet/tarjeta) =====
    if (st === 'RET_DEST') {
      const uid = chatId;
      const draft = retiroDraft[uid]; // { monto, moneda }
      const destino = txtRaw;

      if (!draft || !draft.monto || !draft.moneda) {
        await ctx.reply('No encuentro tu solicitud. Vuelve a iniciar con "Retirar".');
        estado[uid] = undefined;
        return;
      }

      // Guardamos en la tabla de retiros
      const insR = await supabase.from('retiros').insert([{
        telegram_id: uid,
        monto: numero(draft.monto),
        estado: 'pendiente',
        metodo: draft.moneda, // Ahora guardamos la moneda como método
        destino: destino,
        moneda: draft.moneda  // Nueva columna para claridad
      }]).select('id').single();

      if (insR.error) {
        console.log('Error insert retiro:', insR.error);
        await ctx.reply('No se pudo crear el retiro. Intenta nuevamente.');
        estado[uid] = undefined;
        delete retiroDraft[uid];
        return;
      }

      const retId = insR.data.id;

      await ctx.reply(
        `✅ Retiro creado (pendiente).\n\n` +
        `ID: ${retId}\n` +
        `Monto: ${numero(draft.monto).toFixed(draft.moneda === 'USDT' ? 2 : 0)} ${draft.moneda}\n` +
        `Método: ${draft.moneda}\n` +
        `Destino: ${destino}`,
        menu()
      );

      // Aviso detallado al admin/canal
      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          [
            '🧾 RETIRO pendiente',
            `ID: #${retId}`,
            `Usuario: ${uid}`,
            `Monto: ${numero(draft.monto).toFixed(draft.moneda === 'USDT' ? 2 : 0)} ${draft.moneda}`,
            `Método: ${draft.moneda}`,
            `Destino: ${destino}`,
          ].join('\n'),
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Aprobar retiro', callback_data: `ret:approve:${retId}` }],
                [{ text: '❌ Rechazar retiro', callback_data: `ret:reject:${retId}` }],
              ],
            },
          }
        );
      } catch (e) {
        console.log('Error notificando al canal de retiros:', e);
      }

      // limpiar estado
      estado[uid] = undefined;
      delete retiroDraft[uid];
      return;
    }

  } catch (e) {
    console.log('Error en handler de texto:', e);
    try { await ctx.reply('Ocurrió un error procesando tu mensaje.'); } catch {}
  }
});

// ======== Handlers para retiros con selección de moneda ========
bot.action('ret:moneda:USDT', async (ctx) => {
  const uid = ctx.from.id;
  estado[uid] = 'RET_USDT';
  retiroDraft[uid] = { moneda: 'USDT' };
  
  const saldos = await saldosPorMoneda(uid);
  const bonos = await carteraBonosDe(uid);
  const disponible = saldos.USDT + bonos.saldo;
  
  await ctx.answerCbQuery();
  await ctx.reply(
    `💵 **Retiro en USDT**\n\n` +
    `Disponible: ${disponible.toFixed(2)} USDT\n` +
    `Fee de retiro: ${RETIRO_FEE_USDT} USDT\n\n` +
    `Escribe el monto a retirar (solo número, ej: 25.00)`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('ret:moneda:CUP', async (ctx) => {
  const uid = ctx.from.id;
  estado[uid] = 'RET_CUP';
  retiroDraft[uid] = { moneda: 'CUP' };
  
  const saldos = await saldosPorMoneda(uid);
  
  await ctx.answerCbQuery();
  await ctx.reply(
    `💰 **Retiro en CUP**\n\n` +
    `Disponible: ${saldos.CUP.toFixed(0)} CUP\n` +
    `*Sin fee de retiro para CUP*\n\n` +
    `Escribe el monto a retirar (solo número, ej: 10000)`,
    { parse_mode: 'Markdown' }
  );
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

    // Marcar depósito como aprobado y activar la inversión
    await supabase.from('depositos')
      .update({ 
        estado: 'aprobado',
        fecha_aprobacion: new Date().toISOString()
      })
      .eq('id', depId);

// ===== PAGO DE REFERIDO (10%) -> patrocinador =====
try {
  // busca el patrocinador del usuario que depositó
  const { data: u, error: uErr } = await supabase
    .from('usuarios')
    .select('patrocinador_id')
    .eq('telegram_id', d.telegram_id)
    .maybeSingle();

  if (uErr) console.log('[BONO] error buscando usuario:', uErr);

  const sponsorId = u?.patrocinador_id ? Number(u.patrocinador_id) : 0;
  console.log('[BONO] sponsorId para', d.telegram_id, '=>', sponsorId);

  // si no hay patrocinador válido, no pagamos
  if (!sponsorId || Number.isNaN(sponsorId) || sponsorId === d.telegram_id) {
    console.log('[BONO] sin patrocinador válido; no se paga 10%.');
  } else {
    // 10% del depósito en la misma moneda que invirtió el referido
    const bonoMonto = numero(d.monto_origen) * 0.10;
    const monedaBono = d.moneda; // Usar la misma moneda del depósito

    // Si es CUP, creamos una inversión ficticia de bono en CUP
    // Si es USDT, lo manejamos como antes en la cartera de bonos
    if (monedaBono === 'CUP') {
      // Crear inversión ficticia de bono en CUP
      await supabase.from('depositos').insert([{
        telegram_id: sponsorId,
        monto: bonoMonto / (d.tasa_usdt || CUP_USDT_RATE), // Equivalente en USDT para monto
        moneda: 'CUP',
        monto_origen: bonoMonto,
        tasa_usdt: d.tasa_usdt || CUP_USDT_RATE,
        estado: 'aprobado',
        ganado_disponible: bonoMonto, // El bono está disponible inmediatamente
        ganado_total: bonoMonto,
        fecha_creacion: new Date().toISOString(),
        fecha_aprobacion: new Date().toISOString(),
        es_bono_referido: true // Marcar como bono para diferenciarlo
      }]);
    } else {
      // USDT: usar el sistema de cartera como antes
      await asegurarUsuario(sponsorId);
      const carS = await carteraBonosDe(sponsorId);

      await actualizarCarteraBonos(sponsorId, {
        saldo: carS.saldo + bonoMonto,
        bono:  carS.bono  + bonoMonto,
        ganado_total: carS.ganado_total + bonoMonto
      });
    }

    // Aplicar el bono como acelerador para reducir el tope de las inversiones activas del sponsor
    await aplicarAceleradorBono(sponsorId, bonoMonto, monedaBono);

    try {
      await bot.telegram.sendMessage(
        sponsorId,
        `🎉 Bono de referido acreditado: ${bonoMonto.toFixed(monedaBono === 'USDT' ? 2 : 0)} ${monedaBono}\n` +
        `Por el depósito de tu referido ${d.telegram_id}.\n` +
        `Este bono también actúa como acelerador para reducir el tope del 500% en tus inversiones activas de ${monedaBono}.`
      );
    } catch (eMsg) {
      console.log('[BONO] no pude notificar al sponsor:', eMsg?.message || eMsg);
    }
  }
} catch (e) {
  console.log('[BONO] error general:', e);
}

    // Aviso al usuario
    try {
      await bot.telegram.sendMessage(
        d.telegram_id,
        `✅ Inversión aprobada!\n\n` +
        `💰 Monto: ${numero(d.monto_origen).toFixed(d.moneda === 'USDT' ? 2 : 0)} ${d.moneda}\n` +
        `📊 ID de inversión: #${depId}\n` +
        `🎯 Tope máximo: 500% (${(numero(d.monto_origen) * 5).toFixed(d.moneda === 'USDT' ? 2 : 0)} ${d.moneda})\n\n` +
        `¡Comenzarás a recibir ganancias diarias!`
      );
    } catch {}

    await ctx.editMessageReplyMarkup();
    await ctx.reply(`Inversión aprobada: ${numero(d.monto_origen).toFixed(d.moneda === 'USDT' ? 2 : 0)} ${d.moneda}`);
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

// ======== Aprobar/Rechazar Retiro ========
bot.action(/ret:approve:(\d+)/, async (ctx) => {
  try {
    if (ctx.from.id !== ADMIN_ID && ctx.chat?.id !== ADMIN_GROUP_ID) return;
    const rid = Number(ctx.match[1]);
    const { data: r } = await supabase.from('retiros').select('*').eq('id', rid).single();
    if (!r || r.estado !== 'pendiente') return ctx.answerCbQuery('Ya procesado');

    const moneda = r.moneda || r.metodo; // Por compatibilidad
    const saldos = await saldosPorMoneda(r.telegram_id);
    const bonos = await carteraBonosDe(r.telegram_id);
    
    let disponible = saldos[moneda] || 0;
    if (moneda === 'USDT') {
      disponible += bonos.saldo;
    }

    let fee = moneda === 'USDT' ? RETIRO_FEE_USDT : 0;
    const totalDebitar = r.monto + fee;

    if (totalDebitar > disponible) {
      return ctx.answerCbQuery('Saldo insuficiente');
    }

    // Debitar de las inversiones y bonos
    if (moneda === 'USDT') {
      // Primero debitar de bonos si es necesario
      let restante = totalDebitar;
      if (bonos.saldo > 0) {
        const deBonos = Math.min(restante, bonos.saldo);
        await actualizarCarteraBonos(r.telegram_id, {
          saldo: bonos.saldo - deBonos
        });
        restante -= deBonos;
      }
      
      // Luego debitar de inversiones USDT
      if (restante > 0) {
        const inversiones = await inversionesDe(r.telegram_id);
        const invUSDT = inversiones.filter(inv => inv.moneda === 'USDT');
        
        for (const inv of invUSDT) {
          if (restante <= 0) break;
          const disponibleInv = numero(inv.ganado_disponible);
          if (disponibleInv > 0) {
            const debitar = Math.min(restante, disponibleInv);
            await supabase.from('depositos')
              .update({ ganado_disponible: disponibleInv - debitar })
              .eq('id', inv.id);
            restante -= debitar;
          }
        }
      }
    } else {
      // Debitar de inversiones CUP
      const inversiones = await inversionesDe(r.telegram_id);
      const invCUP = inversiones.filter(inv => inv.moneda === 'CUP');
      
      let restante = totalDebitar;
      for (const inv of invCUP) {
        if (restante <= 0) break;
        const disponibleInv = numero(inv.ganado_disponible);
        if (disponibleInv > 0) {
          const debitar = Math.min(restante, disponibleInv);
          await supabase.from('depositos')
            .update({ ganado_disponible: disponibleInv - debitar })
            .eq('id', inv.id);
          restante -= debitar;
        }
      }
    }

    await supabase.from('retiros').update({ estado: 'aprobado' }).eq('id', rid);

    // Notificar al usuario
    await bot.telegram.sendMessage(
      r.telegram_id, 
      `✅ Retiro aprobado: ${r.monto.toFixed(moneda === 'USDT' ? 2 : 0)} ${moneda}`
    );

    // Notificar al canal de pagos (público) solo si está configurado
    if (PAYMENT_CHANNEL) {
      try {
        const userIdCensurado = `***${String(r.telegram_id).slice(-3)}`;
        const fechaHora = new Date().toLocaleString('es-ES', { 
          timeZone: 'America/Havana',
          day: '2-digit',
          month: '2-digit', 
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        
        const mensajeCanal = 
          `💸 **Retiro Procesado**\n\n` +
          `✅ Monto: ${r.monto.toFixed(moneda === 'USDT' ? 2 : 0)} ${moneda}\n` +
          `👤 Usuario: ${userIdCensurado}\n` +
          `💳 Método: ${moneda === 'USDT' ? 'USDT (BEP20)' : 'CUP (Tarjeta)'}\n` +
          `🕐 Fecha: ${fechaHora}`;

        await bot.telegram.sendMessage(PAYMENT_CHANNEL, mensajeCanal, { 
          parse_mode: 'Markdown' 
        });
        console.log(`✅ Notificación de retiro enviada al canal ${PAYMENT_CHANNEL}`);
      } catch (ePagos) {
        console.error('❌ Error notificando al canal de pagos:', ePagos?.message || ePagos);
        console.error('🔍 Detalles del error:', {
          channelId: PAYMENT_CHANNEL,
          errorCode: ePagos?.code,
          errorDescription: ePagos?.description
        });
      }
    } else {
      console.log('⚠️ PAYMENT_CHANNEL no configurado, saltando notificación al canal público');
    }

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
// Paso método USDT
bot.action('ret:m:usdt', async (ctx) => {
  const uid = ctx.from.id;
  if (!retiroDraft[uid] || !retiroDraft[uid].monto) {
    return ctx.answerCbQuery('Primero escribe el monto.');
  }
  retiroDraft[uid].metodo = 'USDT';
  estado[uid] = 'RET_DEST';
  await ctx.answerCbQuery();
  await ctx.reply('Escribe tu wallet USDT (BEP20) donde quieres recibir el pago:');
});

// Paso método CUP
bot.action('ret:m:cup', async (ctx) => {
  const uid = ctx.from.id;
  if (!retiroDraft[uid] || !retiroDraft[uid].monto) {
    return ctx.answerCbQuery('Primero escribe el monto.');
  }
  retiroDraft[uid].metodo = 'CUP';
  estado[uid] = 'RET_DEST';
  await ctx.answerCbQuery();
  await ctx.reply('Escribe el número de tu tarjeta CUP (16 dígitos) donde quieres recibir el pago:');
});

// ======== /pagarhoy (pago manual robusto para inversiones individuales) ========
bot.command('pagarhoy', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Solo admin.');

  try {
    // Obtener la tasa del día
    const tasaDelDia = await obtenerPorcentajeDelDia();
    const rate = tasaDelDia / 100; // Convertir porcentaje a decimal

    // Obtener todas las inversiones aprobadas (excluyendo bonos)
    const { data: inversiones, error } = await supabase
      .from('depositos')
      .select('*')
      .eq('estado', 'aprobado')
      .neq('es_bono_referido', true) // Excluir bonos de referido
      .order('id', { ascending: true });

    if (error) {
      console.log('/pagarhoy select error:', error);
      return ctx.reply('Error leyendo inversiones.');
    }
    if (!inversiones || !inversiones.length) return ctx.reply('No hay inversiones activas.');

    let totalPagadoUSDT = 0;
    let totalPagadoCUP = 0;
    let cuentasPagadas = 0;
    const log = [];

    for (const inv of inversiones) {
      const userId = Number(inv.telegram_id);
      const montoBase = numero(inv.monto_origen);
      const moneda = inv.moneda;
      const ganadoTotal = numero(inv.ganado_total);
      const ganadoDisponible = numero(inv.ganado_disponible);

      if (montoBase <= 0) {
        log.push(`Inv #${inv.id}: sin monto base`);
        continue;
      }

      // Verificar tope 500% considerando acelerador
      const acelerador = numero(inv.acelerador_usado) || 0;
      const tope = montoBase * 5 - acelerador; // Tope reducido por acelerador
      if (ganadoTotal >= tope) {
        log.push(`Inv #${inv.id}: tope alcanzado (${ganadoTotal.toFixed(2)}/${tope.toFixed(2)}, acelerador: ${acelerador.toFixed(2)})`);
        continue;
      }

      // Calcular pago usando la tasa del día
      let pago = montoBase * rate;

      // Verificar que no exceda el tope
      const margen = tope - ganadoTotal;
      if (pago > margen) pago = margen;
      
      if (pago <= 0) {
        log.push(`Inv #${inv.id}: pago <= 0`);
        continue;
      }

      // Actualizar la inversión
      await supabase.from('depositos').update({
        ganado_disponible: ganadoDisponible + pago,
        ganado_total: ganadoTotal + pago
      }).eq('id', inv.id);

      // Contabilizar
      if (moneda === 'USDT') {
        totalPagadoUSDT += pago;
      } else {
        totalPagadoCUP += pago;
      }
      cuentasPagadas += 1;
      
      log.push(`Inv #${inv.id} (${userId}): ${pago.toFixed(moneda === 'USDT' ? 4 : 0)} ${moneda} (tasa ${tasaDelDia}%)`);

      // Notificar al usuario
      try {
        await bot.telegram.sendMessage(
          userId, 
          `💸 Pago acreditado: ${pago.toFixed(moneda === 'USDT' ? 2 : 0)} ${moneda}\n` +
          `📊 Inversión #${inv.id} (Tasa del día: ${tasaDelDia}%)`
        );
      } catch (eNoti) {
        console.log('No pude notificar a', userId, eNoti?.message || eNoti);
      }
    }

    const resumen =
      `✅ /pagarhoy completado (Tasa: ${tasaDelDia}%).\n` +
      `Inversiones pagadas: ${cuentasPagadas}\n` +
      `Total USDT: ${totalPagadoUSDT.toFixed(2)}\n` +
      `Total CUP: ${totalPagadoCUP.toFixed(0)}\n` +
      (log.length ? `\nDetalle:\n${log.slice(0, 30).join('\n')}${log.length > 30 ? '\n…' : ''}` : '');

    await ctx.reply(resumen);

  } catch (e) {
    console.log('/pagarhoy error:', e);
    try { await ctx.reply('Error en pagarhoy. Revisa logs.'); } catch {}
  }
});

// ======== Comandos para Tasa Diaria ========
bot.command('porcentajedeldia', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Solo admin.');

  const argumento = ctx.message.text.split(' ')[1];
  if (!argumento) {
    return ctx.reply('Uso: /porcentajedeldia <porcentaje>\nEjemplo: /porcentajedeldia 1.5');
  }

  const porcentaje = numero(argumento);
  if (porcentaje <= 0 || porcentaje > 10) {
    return ctx.reply('El porcentaje debe ser mayor a 0 y máximo 10%');
  }

  try {
    const exito = await establecerPorcentajeDelDia(porcentaje);
    if (!exito) {
      return ctx.reply('Error guardando el porcentaje en la base de datos.');
    }

    // Notificar a todos los usuarios
    const notificados = await notificarNuevaTasa(porcentaje);
    
    await ctx.reply(
      `✅ Porcentaje del día establecido: ${porcentaje}%\n` +
      `📨 Notificados: ${notificados} usuarios`
    );

  } catch (e) {
    console.log('/porcentajedeldia error:', e);
    await ctx.reply('Error configurando el porcentaje del día.');
  }
});

bot.command('porcentajehoy', async (ctx) => {
  try {
    const porcentaje = await obtenerPorcentajeDelDia();
    await ctx.reply(`📊 Porcentaje del día: ${porcentaje}%`);
  } catch (e) {
    console.log('/porcentajehoy error:', e);
    await ctx.reply('Error obteniendo el porcentaje del día.');
  }
});

// ======== Comando de diagnóstico para admin ========
bot.command('diagnostico', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('Solo admin.');

  try {
    // Verificar conexión con Supabase
    const { data: testData, error: testError } = await supabase
      .from('usuarios')
      .select('count')
      .limit(1);

    // Verificar tasa diaria
    const porcentaje = await obtenerPorcentajeDelDia();

    // Obtener estadísticas básicas
    const { data: usuarios } = await supabase.from('usuarios').select('count');
    const { data: depositos } = await supabase.from('depositos').select('count');
    const { data: retiros } = await supabase.from('retiros').select('count');

    const diagnostico = 
      `🔍 **Diagnóstico del Sistema**\n\n` +
      `✅ **Conexiones:**\n` +
      `• Telegram: ✅ Activo\n` +
      `• Supabase: ${testError ? '❌ Error' : '✅ Activo'}\n\n` +
      `📊 **Configuración:**\n` +
      `• Tasa del día: ${porcentaje}%\n` +
      `• Canal de pagos: ${PAYMENT_CHANNEL ? '✅ Configurado' : '⚠️ No configurado'}\n` +
      `• Min inversión: ${MIN_INVERSION} USDT\n` +
      `• Fee retiro: ${RETIRO_FEE_USDT} USDT\n` +
      `• Tasa CUP/USDT: ${CUP_USDT_RATE}\n\n` +
      `📈 **Estadísticas:**\n` +
      `• Usuarios: ${usuarios?.[0]?.count || 0}\n` +
      `• Depósitos: ${depositos?.[0]?.count || 0}\n` +
      `• Retiros: ${retiros?.[0]?.count || 0}\n\n` +
      `🌐 **Servidor:**\n` +
      `• Puerto: ${PORT}\n` +
      `• Host: ${HOST_URL}\n` +
      `• Webhook: /webhook/${WEBHOOK_SECRET}`;

    await ctx.reply(diagnostico, { parse_mode: 'Markdown' });

    if (testError) {
      await ctx.reply(`❌ Error Supabase: ${testError.message}`);
    }

  } catch (e) {
    console.error('Error en diagnóstico:', e);
    await ctx.reply(`❌ Error ejecutando diagnóstico: ${e?.message || e}`);
  }
});

// ======== Webhook / Ping con mejor manejo de errores ========
app.get('/', (_, res) => res.send('OK'));

app.post(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  try {
    bot.handleUpdate(req.body, res);
  } catch (error) {
    console.error('❌ Error procesando webhook:', error?.message || error);
    res.status(500).send('Error interno del servidor');
  }
});

app.get('/webhook', async (_, res) => {
  try {
    const url = `${HOST_URL}/webhook/${WEBHOOK_SECRET}`;
    await bot.telegram.setWebhook(url);
    console.log(`✅ Webhook configurado en: ${url}`);
    res.send(`Webhook configurado en: ${url}`);
  } catch (e) {
    console.error('❌ Error configurando webhook:', e?.message || e);
    res.status(500).send('Error configurando webhook: ' + (e?.message || e));
  }
});

// Lanzar servidor + webhook con mejor manejo de errores
app.listen(PORT, async () => {
  console.log(`🚀 HTTP server iniciado en puerto ${PORT}`);
  try {
    const url = `${HOST_URL}/webhook/${WEBHOOK_SECRET}`;
    await bot.telegram.setWebhook(url);
    console.log(`✅ Webhook configurado automáticamente en: ${url}`);
  } catch (e) {
    console.error('❌ Error configurando webhook automáticamente:', e?.message || e);
    console.error('💡 Puedes configurarlo manualmente visitando: /webhook');
  }
});

// Paradas elegantes
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));



































