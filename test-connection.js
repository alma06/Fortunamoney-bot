#!/usr/bin/env node

/**
 * Script de prueba de conexión para FortunaMoney Bot
 * Verifica todas las conexiones y configuraciones básicas
 */

require('dotenv').config();
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Colores para consola
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(level, message) {
  const timestamp = new Date().toISOString();
  const color = {
    'SUCCESS': colors.green,
    'ERROR': colors.red,
    'WARN': colors.yellow,
    'INFO': colors.blue
  }[level] || '';
  
  console.log(`${color}[${timestamp}] ${level}: ${message}${colors.reset}`);
}

async function testConnection() {
  log('INFO', '🚀 Iniciando pruebas de conexión...');
  
  // Verificar variables de entorno
  log('INFO', '📋 Verificando variables de entorno...');
  
  const requiredVars = [
    'BOT_TOKEN',
    'SUPABASE_URL', 
    'SUPABASE_KEY',
    'ADMIN_ID',
    'ADMIN_GROUP_ID',
    'HOST_URL'
  ];
  
  let allVarsOk = true;
  
  for (const varName of requiredVars) {
    if (process.env[varName]) {
      log('SUCCESS', `✅ ${varName}: Configurado`);
    } else {
      log('ERROR', `❌ ${varName}: Faltante`);
      allVarsOk = false;
    }
  }
  
  // Variables opcionales
  const optionalVars = ['PAYMENT_CHANNEL', 'WEBHOOK_SECRET'];
  for (const varName of optionalVars) {
    if (process.env[varName]) {
      log('SUCCESS', `✅ ${varName}: Configurado`);
    } else {
      log('WARN', `⚠️ ${varName}: No configurado (opcional)`);
    }
  }
  
  if (!allVarsOk) {
    log('ERROR', '❌ Faltan variables de entorno obligatorias');
    process.exit(1);
  }
  
  // Probar conexión con Telegram
  log('INFO', '🤖 Probando conexión con Telegram...');
  try {
    const bot = new Telegraf(process.env.BOT_TOKEN);
    const botInfo = await bot.telegram.getMe();
    log('SUCCESS', `✅ Conectado a Telegram como: @${botInfo.username}`);
  } catch (error) {
    log('ERROR', `❌ Error conectando con Telegram: ${error.message}`);
    process.exit(1);
  }
  
  // Probar conexión con Supabase
  log('INFO', '🗄️ Probando conexión con Supabase...');
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    
    // Probar query simple
    const { data, error } = await supabase
      .from('usuarios')
      .select('count')
      .limit(1);
      
    if (error) {
      throw error;
    }
    
    log('SUCCESS', '✅ Conectado a Supabase correctamente');
    
    // Verificar tablas necesarias
    log('INFO', '📊 Verificando estructura de base de datos...');
    
    const tables = ['usuarios', 'depositos', 'retiros', 'carteras', 'tasa_diaria'];
    
    for (const table of tables) {
      try {
        const { error: tableError } = await supabase
          .from(table)
          .select('*')
          .limit(1);
          
        if (tableError) {
          throw tableError;
        }
        
        log('SUCCESS', `✅ Tabla '${table}': Existe y accesible`);
      } catch (tableError) {
        log('ERROR', `❌ Tabla '${table}': ${tableError.message}`);
      }
    }
    
  } catch (error) {
    log('ERROR', `❌ Error conectando con Supabase: ${error.message}`);
    process.exit(1);
  }
  
  // Verificar configuración de red
  log('INFO', '🌐 Verificando configuración de red...');
  
  const port = process.env.PORT || 3000;
  const hostUrl = process.env.HOST_URL;
  
  log('INFO', `📡 Puerto configurado: ${port}`);
  log('INFO', `🔗 URL del host: ${hostUrl}`);
  
  if (hostUrl && !hostUrl.startsWith('http')) {
    log('WARN', '⚠️ HOST_URL debería empezar con http:// o https://');
  }
  
  log('SUCCESS', '🎉 Todas las pruebas de conexión completadas exitosamente!');
  log('INFO', '💡 El bot debería funcionar correctamente en producción');
  
  process.exit(0);
}

// Ejecutar pruebas
testConnection().catch(error => {
  log('ERROR', `💥 Error inesperado: ${error.message}`);
  console.error(error);
  process.exit(1);
});
