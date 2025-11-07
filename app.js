// app.js - Main Application File

require('dotenv').config();
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { loadSeenTickers, saveSeenTickers, loadScheduledTickers, saveScheduledTickers } = require('./utils.js');
// Import the new autoScheduleNextGame and getGameIdFromUrl helpers
const { initializePolling, masterScheduler, dispatcherLoop, startPolling, beginActualPolling, getGameIdFromUrl, autoScheduleNextGame } = require('./polling.js');

// --- GLOBAL STATE ---
const activeTickers = new Map();
const jobQueue = [];
const SEEN_FILE = path.resolve(__dirname, 'seen_tickers.json');
const SCHEDULE_FILE = path.resolve(__dirname, 'scheduled_tickers.json');

// --- WHATSAPP CLIENT INITIALIZATION ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox'], 
        executablePath: '/usr/bin/chromium' 
    }
});

// --- INITIALIZE MODULES ---
initializePolling(activeTickers, jobQueue, client, SEEN_FILE, SCHEDULE_FILE);

// --- WHATSAPP CLIENT EVENT HANDLERS ---

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('QR-Code generiert. Scannen Sie diesen mit WhatsApp.');
});

client.on('ready', () => {
    console.log('WhatsApp-Client ist bereit!');
    loadSeenTickers(activeTickers, SEEN_FILE);

    const scheduledTickersData = loadScheduledTickers(SCHEDULE_FILE);
    const currentSchedule = scheduledTickersData; // for cleaning up
    const now = Date.now();
    let rescheduledCount = 0;

    for (const chatId in scheduledTickersData) {
        const scheduleData = scheduledTickersData[chatId];
        const startTime = new Date(scheduleData.startTime);
        const delay = startTime.getTime() - now;

        const gameId = getGameIdFromUrl(scheduleData.meetingPageUrl);
        if (!gameId) {
            console.warn(`[${chatId}] Überspringe geladenen Ticker, ungültige URL: ${scheduleData.meetingPageUrl}`);
            continue; 
        }

        const tickerState = activeTickers.get(chatId) || { seen: new Set() };
        tickerState.meetingPageUrl = scheduleData.meetingPageUrl;
        tickerState.gameId = gameId; 
        tickerState.groupName = scheduleData.groupName;
        tickerState.mode = scheduleData.mode; 
        // --- ADDED FOR AUTOSCHEDULE RESTART ---
        tickerState.isAutoSchedule = scheduleData.isAutoSchedule || false;
        tickerState.teamPageUrl = scheduleData.teamPageUrl || null;
        // --- END ---
        tickerState.recapEvents = []; 
        tickerState.isPolling = false; 
        activeTickers.set(chatId, tickerState); 

        if (delay > 0) {
            console.log(`[${chatId}] Lade geplante Aufgabe. Startet in ${Math.round(delay / 60000)} Minuten.`);
            tickerState.isScheduled = true;
            tickerState.scheduleTimeout = setTimeout(() => {
                beginActualPolling(chatId);
            }, delay);
            rescheduledCount++;
        } else {
             // If it's an old, finished game that was just scheduled, clean it up.
             if (!activeTickers.has(chatId)) { // Check if it's already running
                 console.log(`[${chatId}] Geplante Startzeit verpasst, Ticker war nicht aktiv. Wird ignoriert.`);
                 delete currentSchedule[chatId];
                 saveScheduledTickers(currentSchedule, SCHEDULE_FILE);
             }
        }
    }
    if (rescheduledCount > 0) {
        console.log(`${rescheduledCount} Ticker erfolgreich neu geplant.`);
    }
});

client.on('disconnected', (reason) => {
    console.log('Client getrennt:', reason);
    activeTickers.forEach(ticker => {
        ticker.isPolling = false;
        ticker.isScheduled = false; 
        if (ticker.scheduleTimeout) clearTimeout(ticker.scheduleTimeout); 
        if (ticker.recapIntervalId) clearInterval(ticker.recapIntervalId);
     });
    saveSeenTickers(activeTickers, SEEN_FILE); 
});

// --- MESSAGE LISTENER ---
client.on('message', async msg => {
    if (!msg.body.startsWith('!')) return;

    const chat = await msg.getChat();
    if (!chat.isGroup) {
        await msg.reply('Fehler: Befehle funktionieren nur in Gruppen.');
        return;
    }

    const chatId = chat.id._serialized; 
    const args = msg.body.split(' ');   
    const command = args[0].toLowerCase(); 
    const groupName = chat.name;          

    // --- !start Command ---
    if (command === '!start' && args.length >= 2) { 
        if (activeTickers.has(chatId) && (activeTickers.get(chatId).isPolling || activeTickers.get(chatId).isScheduled)) {
            await msg.reply('In dieser Gruppe läuft oder ist bereits ein Live-Ticker geplant. Stoppen oder resetten Sie ihn zuerst.');
            return;
        }
        const meetingPageUrl = args[1]; 
        const mode = (args[2] && args[2].toLowerCase() === 'recap') ? 'recap' : 'live';

        try {
            // Call startPolling (queueTickerScheduling) with isAutoSchedule = false
            await startPolling(meetingPageUrl, chatId, groupName, mode, false, null);
        } catch (error) {
            console.error(`[${chatId}] Kritischer Fehler beim Starten des Tickers:`, error);
            await msg.reply('Ein kritischer Fehler ist aufgetreten und der Ticker konnte nicht gestartet werden.');
            activeTickers.delete(chatId); 
        }
    }
    // --- !stop Command ---
    else if (command === '!stop') { 
        const tickerState = activeTickers.get(chatId);
        let wasStopped = false; 

        if (tickerState) {
            // --- NEW: Disable auto-scheduling on manual stop ---
            if (tickerState.isAutoSchedule) {
                tickerState.isAutoSchedule = false;
                console.log(`[${chatId}] Auto-Schedule Kette gestoppt.`);
            }
            // --- END NEW ---
            
            if (tickerState.isScheduled && tickerState.scheduleTimeout) {
                clearTimeout(tickerState.scheduleTimeout);
                tickerState.isScheduled = false;
                const currentSchedule = loadScheduledTickers(SCHEDULE_FILE);
                if (currentSchedule[chatId]) {
                    delete currentSchedule[chatId];
                    saveScheduledTickers(currentSchedule, SCHEDULE_FILE);
                }
                wasStopped = true;
            }
            if (tickerState.isPolling) {
                tickerState.isPolling = false;
                if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
                wasStopped = true;
            }
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }

        if (wasStopped) {
            await client.sendMessage(chatId, 'Laufender/geplanter Live-Ticker in dieser Gruppe gestoppt.');
        } else {
            await msg.reply('In dieser Gruppe läuft derzeit kein Live-Ticker.');
        }
    }
    // --- !reset Command ---
    else if (command === '!reset') { 
        const tickerState = activeTickers.get(chatId);

        if (tickerState) {
            if (tickerState.scheduleTimeout) clearTimeout(tickerState.scheduleTimeout);
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
            tickerState.isPolling = false;
            tickerState.isScheduled = false;
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }

        activeTickers.delete(chatId);
        saveSeenTickers(activeTickers, SEEN_FILE);

        const currentSchedule = loadScheduledTickers(SCHEDULE_FILE);
        if (currentSchedule[chatId]) {
            delete currentSchedule[chatId];
            saveScheduledTickers(currentSchedule, SCHEDULE_FILE);
        }

        await msg.reply('Alle Ticker-Daten für diese Gruppe wurden zurückgesetzt.');
        console.log(`Ticker-Daten für Gruppe "${groupName}" (${chatId}) wurden manuell zurückgesetzt.`);
    }
    // --- !start command without a URL ---
    else if (command === '!start') { 
        await msg.reply(`Fehler: Bitte geben Sie eine gültige URL an. Format:\n\n!start <URL> [recap]`);
    }
    
    // --- !autoschedule Command (NEW) ---
    else if (command === '!autoschedule' && args.length >= 2) {
        if (activeTickers.has(chatId) && (activeTickers.get(chatId).isPolling || activeTickers.get(chatId).isScheduled)) {
            await msg.reply('In dieser Gruppe läuft oder ist bereits ein Live-Ticker geplant. Bitte `!stop` oder `!reset` zuerst.');
            return;
        }
        
        const teamPageUrl = args[1];
        const mode = (args[2] && args[2].toLowerCase() === 'recap') ? 'recap' : 'live';
        
        try {
            await client.sendMessage(chatId, `🤖 Analysiere Team-Spielplan... Dies kann einen Moment dauern.`);
            // Call the new function
            const gameScheduled = await autoScheduleNextGame(teamPageUrl, chatId, groupName, mode);
            
            if (gameScheduled) {
                 await client.sendMessage(chatId, `✅ Auto-Planung erfolgreich! Das nächste Spiel wurde gefunden und geplant:\n\n*${gameScheduled.homeTeam.name}* vs *${gameScheduled.awayTeam.name}*\nam ${new Date(gameScheduled.startsAt).toLocaleDateString('de-DE', {weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'})}\num ${new Date(gameScheduled.startsAt).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'})} Uhr.\n\nNach Spielende wird automatisch das nächste Spiel geplant.`);
            } else {
                 await client.sendMessage(chatId, `ℹ️ Es wurden keine zukünftigen Spiele für dieses Team gefunden, die geplant werden können.`);
            }
        
        } catch (error) {
            console.error(`[${chatId}] Kritischer Fehler beim Auto-Scheduling:`, error);
            await msg.reply(`Ein Fehler ist aufgetreten: ${error.message}`);
        }
    }
    // --- Handle !autoschedule command without a URL ---
    else if (command === '!autoschedule') {
        await msg.reply(`Fehler: Bitte geben Sie eine Team-URL an. Format:\n\n!autoschedule <Team-URL> [recap]`);
    }
});

// --- MAIN EXECUTION ---
setInterval(masterScheduler, 5000); 
setInterval(dispatcherLoop, 500); 
client.initialize();

// --- GRACEFUL SHUTDOWN HANDLER ---
process.on('SIGINT', async () => {
    console.log('(SIGINT) Empfangen. Bot wird heruntergefahren...');
    activeTickers.forEach(ticker => {
        ticker.isPolling = false;
        ticker.isScheduled = false;
        if (ticker.scheduleTimeout) clearTimeout(ticker.scheduleTimeout);
        if (ticker.recapIntervalId) clearInterval(tickerState.recapIntervalId);
     });
    saveSeenTickers(activeTickers, SEEN_FILE); 
    if (client) await client.destroy(); 
    process.exit(0); 
});