// ======================
//       IMPORTS
// ======================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const fs = require('fs').promises; // Usamos promesas
const fsSync = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn, exec } = require('child_process');
const cron = require('node-cron');

// ======================
//     CONFIGURACIÓN
// ======================
const client = new Client({ 
    authStrategy: new LocalAuth(),
    puppeteer: { 
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: process.env.CHROME_PATH || undefined 
    }
});

const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'xioma6313',
    database: 'cafe_albania'
};

const db = mysql.createPool(dbConfig);

const API_URL = process.env.API_URL;
const IMAGES_BASE_DIR = process.env.IMAGES_BASE_DIR;
const QR_FILE_NAME = process.env.QR_FILE_NAME || 'whatsapp_qr.png';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 60000;
const API_PATH = process.env.API_PATH;
const LOG_FILE = path.join(__dirname, 'logs', 'monitor.log');
const ADMIN_NUMBERS = process.env.ADMIN_NUMBERS 
    ? process.env.ADMIN_NUMBERS.split(',').map(n => n.trim().replace('+', '') + '@c.us') 
    : [];

// ======================
//   VARIABLES DE ESTADO
// ======================
let apiCaida = false;
let intentosFallidos = 0;
let ultimaCaida = null;
let totalCaidas = 0;
let imagenesLimpiadasHoy = 0;
const uptimeStart = Date.now();

// Asegurar carpeta de logs
if (!fsSync.existsSync(path.dirname(LOG_FILE))) {
    fsSync.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

// ======================
//   FUNCIONES NÚCLEO
// ======================

async function logEvent(message) {
    const timestamp = new Date().toLocaleString();
    const logMsg = `[${timestamp}] ${message}\n`;
    try {
        await fs.appendFile(LOG_FILE, logMsg);
        console.log(logMsg.trim());
    } catch (err) {
        console.error('Error escribiendo log:', err);
    }
}

async function sendAlertMessage(message) {
    for (const chatId of ADMIN_NUMBERS) {
        try {
            await client.sendMessage(chatId, message);
        } catch (err) {
            console.error(`❌ Error enviando a ${chatId}: ${err.message}`);
        }
    }
}

/**
 * Inicia la API en una nueva ventana de terminal (Windows)
 */
function startApi() {
    logEvent('🚀 Iniciando proceso de la API...');
    // Usamos cmd /c start para abrir una ventana independiente
    const command = `start cmd.exe /K "cd /d ${API_PATH} && npm start"`;
    
    exec(command, (error) => {
        if (error) logEvent(`❌ Error al ejecutar startApi: ${error.message}`);
    });
}

/**
 * Limpia imágenes del servidor que no están en la DB
 */
async function cleanUnusedImages() {
    try {
        logEvent('🧹 Iniciando limpieza de imágenes...');
        // 1. Obtener nombres de archivos en la DB (Ajusta 'banners' y 'imagen_url' a tu tabla real)
        const [rows] = await db.execute('SELECT imagen FROM banners'); 
        const dbImages = new Set(rows.map(r => r.imagen));

        // 2. Leer archivos en el directorio
        const files = await fs.readdir(IMAGES_BASE_DIR);
        let count = 0;

        for (const file of files) {
            // No borrar el QR ni archivos que estén en la DB
            if (file === QR_FILE_NAME || dbImages.has(file)) continue;

            await fs.unlink(path.join(IMAGES_BASE_DIR, file));
            count++;
        }

        imagenesLimpiadasHoy += count;
        logEvent(`✅ Limpieza terminada. Se borraron ${count} archivos.`);
        return count;
    } catch (err) {
        logEvent(`❌ Error en limpieza: ${err.message}`);
        return 0;
    }
}

async function checkApiStatus() {
    try {
        const res = await axios.get(`${API_URL}/banners`, { timeout: 8000 });
        
        if (res.status === 200) {
            if (apiCaida) {
                const diff = ((Date.now() - ultimaCaida) / 60000).toFixed(1);
                await sendAlertMessage(`✅ API RECUPERADA tras ${diff} min.`);
                apiCaida = false;
                intentosFallidos = 0;
            }
            return true;
        }
    } catch (err) {
        intentosFallidos++;
        logEvent(`🚨 Fallo de API (${intentosFallidos}/3): ${err.message}`);

        if (!apiCaida) {
            apiCaida = true;
            ultimaCaida = Date.now();
            totalCaidas++;
            await sendAlertMessage('⚠️ ALERTA: La API no responde. Intentando reiniciar...');
            startApi();
        }

        if (intentosFallidos >= 3) {
            logEvent('🔥 Crítico: 3 fallos seguidos. Reiniciando Sistema Operativo...');
            await sendAlertMessage('🆘 API Crítica. Reiniciando servidor físico en 10 segundos...');
            exec('shutdown /r /t 10');
        }
    }
    return false;
}

// ======================
//   EVENTOS WHATSAPP
// ======================

client.on('qr', async (qr) => {
    qrcodeTerminal.generate(qr, { small: true });
    try {
        const qrPath = path.join(IMAGES_BASE_DIR, QR_FILE_NAME);
        await QRCode.toFile(qrPath, qr);
        logEvent(`📱 Nuevo QR generado en: ${qrPath}`);
    } catch (err) {
        logEvent(`❌ Error guardando QR: ${err.message}`);
    }
});

client.on('ready', () => {
    logEvent('🤖 Monitor de Cafe Albania ONLINE');
    // Iniciar bucles
    setInterval(checkApiStatus, CHECK_INTERVAL);
});

client.on('message', async (msg) => {
    if (!ADMIN_NUMBERS.includes(msg.from)) return;

    const command = msg.body.toLowerCase().trim();

    if (command === '/status') {
        const uptime = ((Date.now() - uptimeStart) / 3600000).toFixed(2);
        const status = apiCaida ? '🔴 CAÍDA' : '🟢 ACTIVA';
        msg.reply(`📊 *STATUS*\n\nAPI: ${status}\nUptime Bot: ${uptime}h\nCaídas hoy: ${totalCaidas}\nLimpieza: ${imagenesLimpiadasHoy} imgs`);
    }

    if (command === '/restart') {
        await msg.reply('⚙️ Intentando reiniciar procesos Node...');
        // Mata todos los procesos node excepto este (Cuidado en Windows)
        exec('taskkill /F /IM node.exe /FI "WINDOWTITLE ne Monitor*"', (err) => {
            setTimeout(() => {
                startApi();
                msg.reply('🚀 API re-lanzada.');
            }, 3000);
        });
    }

    if (command === '/clean') {
        const deleted = await cleanUnusedImages();
        msg.reply(`🧹 Limpieza manual completada. Eliminadas: ${deleted}`);
    }

    if (command === '/logs') {
        const data = await fs.readFile(LOG_FILE, 'utf8');
        const lastLines = data.split('\n').slice(-15).join('\n');
        msg.reply(`🧾 *Últimos registros:*\n\n${lastLines}`);
    }
});

// ======================
//      CRON JOBS
// ======================
// Reporte diario a las 8 PM
cron.schedule('0 20 * * *', () => {
    const msg = `📅 *REPORTE DIARIO*\n- Caídas: ${totalCaidas}\n- Limpieza: ${imagenesLimpiadasHoy} imágenes.`;
    sendAlertMessage(msg);
    imagenesLimpiadasHoy = 0; // Reset diario
});

// Limpieza automática Lunes 3 AM
cron.schedule('0 3 * * 1', cleanUnusedImages);

// Inicializar
client.initialize();