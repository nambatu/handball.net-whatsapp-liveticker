// polling.js
const axios = require('axios');
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers, formatRecapEventLine } = require('./utils.js');
const { generateGameSummary, extractGameStats } = require('./ai.js');
const { EVENT_MAP } = require('./config.js');

// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1; 
let activeWorkers = 0; 
const MAX_WORKERS = 2; 
const PRE_GAME_START_MINUTES = 5; 
const RECAP_INTERVAL_MINUTES = 5; 

/**
 * Initializes the polling module with shared state variables from app.js.
 */
function initializePolling(tickers, queue, whatsappClient, seenFile, scheduleFile) {
    activeTickers = tickers;
    jobQueue = queue;
    client = whatsappClient;
    seenFilePath = seenFile;
    scheduleFilePath = scheduleFile;
}

// --- NEW HELPER FUNCTION (v4 - The Robust One!) ---

/**
 * Extracts the Game ID from any valid handball.net URL by finding the
 * path segment that matches the game ID format (e.g., "handball4all...").
 * @param {string} meetingPageUrl - The user-provided URL.
 * @returns {string|null} - The extracted game ID or null.
 */
function getGameIdFromUrl(meetingPageUrl) {
    try {
        const url = new URL(meetingPageUrl);
        const pathname = url.pathname;

        // Split the path into segments, filtering out empty ones
        const segments = pathname.split('/').filter(segment => segment.length > 0);
        
        // Find the first segment that matches our known ID patterns
        // We search in reverse, as the ID is usually near the end.
        for (let i = segments.length - 1; i >= 0; i--) {
            const segment = segments[i];
            if (segment.startsWith('handball4all.') || segment.startsWith('sportradar.')) {
                return segment; // Found it!
            }
        }
        
        // If no match is found after checking all segments
        return null; 

    } catch (e) {
        console.error("Error parsing URL:", e.message);
        return null;
    }
}

/**
 * Builds the full JSON data URL from a game ID.
 * @param {string} gameId - The game ID.
 * @returns {string} - The full API URL.
 */
function buildDataUrl(gameId) {
    return `https://www.handball.net/a/sportdata/1/games/${gameId}/combined?`;
}

// --- END NEW HELPER FUNCTION ---


/**
 * Creates the initial ticker state and adds a 'schedule' job to the queue.
 * @param {string} meetingPageUrl - The URL of the handball.net game webpage.
 * @param {string} chatId - The WhatsApp chat ID where the ticker runs.
 * @param {string} groupName - The name of the WhatsApp group (for AI).
 * @param {('live'|'recap')} mode - The desired ticker mode ('live' or 'recap').
 */
async function queueTickerScheduling(meetingPageUrl, chatId, groupName, mode) {
    // Validate the URL and extract the gameId
    const gameId = getGameIdFromUrl(meetingPageUrl);
    if (!gameId) {
        await client.sendMessage(chatId, 'Fehler: Die angegebene URL ist keine gültige handball.net Spiel-URL oder der Spiel-Code konnte nicht gefunden werden.');
        return;
    }

    // Create initial state in memory
    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = false; 
    tickerState.isScheduling = true;
    tickerState.meetingPageUrl = meetingPageUrl; // Store the user-facing URL
    tickerState.gameId = gameId; // --- Store the extracted Game ID
    tickerState.groupName = groupName;
    tickerState.mode = mode;
    tickerState.recapEvents = []; 
    activeTickers.set(chatId, tickerState); 

    // Add a 'schedule' job to the queue
    jobQueue.push({
        type: 'schedule', 
        chatId,
        gameId: gameId, // Pass the gameId
        meetingPageUrl: meetingPageUrl, // Pass the original URL for saving
        groupName,
        mode,
        jobId: Date.now()
    });

    console.log(`[${chatId}] Planungs-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    await client.sendMessage(chatId, `⏳ Ticker-Planung für "${groupName}" wird bearbeitet...`);
}


/**
 * Activates the actual polling loop for a ticker.
 * (This function is unchanged)
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function beginActualPolling(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState) {
        console.warn(`[${chatId}] Ticker-Status nicht gefunden beim Versuch, das Polling zu starten.`);
        const currentSchedule = loadScheduledTickers(scheduleFilePath);
         if (currentSchedule[chatId]) {
             delete currentSchedule[chatId];
             saveScheduledTickers(currentSchedule, scheduleFilePath);
             console.log(`[${chatId}] Überreste aus Planungsdatei entfernt.`);
         }
        return;
    }
    if (tickerState.isPolling) {
        console.log(`[${chatId}] Polling ist bereits aktiv.`);
        return;
    }

    console.log(`[${chatId}] Aktiviere Polling (Modus: ${tickerState.mode}).`);
    tickerState.isPolling = true; 
    tickerState.isScheduled = false;

    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) {
        delete currentSchedule[chatId]; 
        saveScheduledTickers(currentSchedule, scheduleFilePath); 
        console.log(`[${chatId}] Aus Planungsdatei entfernt.`);
    }

    if (tickerState.mode === 'recap') {
        try {
            let legendMessage = "ℹ️ *Ticker-Legende:*\n";
            for (const key in EVENT_MAP) {
                if (key === "default" || key === "StartPeriod" || key === "StopPeriod") continue;
                const eventDetails = EVENT_MAP[key]; 
                legendMessage += `${eventDetails.emoji} = ${eventDetails.label}\n`;
            }
            await client.sendMessage(chatId, legendMessage.trim());
            console.log(`[${chatId}] Emoji-Legende gesendet (Recap-Modus).`);
        } catch (error) {
            console.error(`[${chatId}] Fehler beim Senden der Legende:`, error);
        }
    }
    
    if (tickerState.mode === 'recap') {
        if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
        tickerState.recapIntervalId = setInterval(() => {
            sendRecapMessage(chatId);
        }, RECAP_INTERVAL_MINUTES * 60 * 1000); 
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    if (!jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.unshift({
            type: 'poll', 
            chatId,
            gameId: tickerState.gameId, // Get gameId from state
            tickerState: tickerState, 
            jobId: Date.now() 
        });
    }
}

/**
 * Sends a recap message.
 * (This function is unchanged)
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState || !tickerState.isPolling || !tickerState.recapEvents || tickerState.recapEvents.length === 0) {
        if (tickerState && tickerState.recapEvents) tickerState.recapEvents = [];
        return; 
    }

    console.log(`[${chatId}] Sende ${tickerState.recapEvents.length} Events im Recap.`);

    tickerState.recapEvents.sort((a, b) => a.timestamp - b.timestamp); 
    const firstEventTime = tickerState.recapEvents[0].time;
    const lastEventTime = tickerState.recapEvents[tickerState.recapEvents.length - 1].time;
    const startMinute = firstEventTime ? firstEventTime.split(':')[0] : '0';
    const endMinute = lastEventTime ? lastEventTime.split(':')[0] : '??';
    const timeRangeTitle = `Minute ${startMinute} - ${endMinute}`;

    const recapLines = tickerState.recapEvents.map(ev => formatRecapEventLine(ev, tickerState));
    const validLines = recapLines.filter(line => line && line.trim() !== '');

    if (validLines.length === 0) {
        console.log(`[${chatId}] Keine gültigen Events zum Senden im Recap gefunden.`);
        tickerState.recapEvents = []; 
        return;
    }

    const teamHeader = `*${tickerState.teamNames.home}* : *${tickerState.teamNames.guest}*`;
    const recapBody = validLines.join('\n'); 
    const finalMessage = `📬 *Recap ${timeRangeTitle}*\n\n${teamHeader}\n${recapBody}`;

    try {
        await client.sendMessage(chatId, finalMessage);
        tickerState.recapEvents = []; // Clear buffer
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        tickerState.recapEvents = []; 
    }
}

/**
 * Master Scheduler: Runs periodically.
 * (Uses gameId)
 */
function masterScheduler() {
    const pollingTickers = Array.from(activeTickers.values()).filter(t => t.isPolling);
    if (pollingTickers.length === 0) return; 

    lastPolledIndex = (lastPolledIndex + 1) % pollingTickers.length;
    const tickerStateToPoll = pollingTickers[lastPolledIndex];
    const chatId = [...activeTickers.entries()].find(([key, val]) => val === tickerStateToPoll)?.[0];

    if (chatId && tickerStateToPoll.isPolling && !jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.push({
             type: 'poll',
             chatId,
             gameId: tickerStateToPoll.gameId, // Pass the gameId
             tickerState: tickerStateToPoll,
             jobId: Date.now()
        });
        console.log(`[${chatId}] Poll-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

/**
 * Dispatcher Loop: Runs frequently.
 * (This function is unchanged)
 */
function dispatcherLoop() {
    if (jobQueue.length > 0 && activeWorkers < MAX_WORKERS) {
        activeWorkers++; 
        const job = jobQueue.shift(); 
        runWorker(job); 
    }
}

/**
 * Executes a single job (either 'schedule' or 'poll') using Axios.
 * (Uses gameId)
 * @param {object} job - The job object from the queue.
 */
async function runWorker(job) {
    const { chatId, jobId, type, gameId, meetingPageUrl } = job; // gameId from poll/schedule, meetingPageUrl from schedule
    const tickerState = activeTickers.get(chatId);
    const timerLabel = `[${chatId}] Job ${jobId} (${type}) Execution Time`;
    console.time(timerLabel); 

    if (!tickerState || (type === 'poll' && !tickerState.isPolling) || (type === 'schedule' && !tickerState.isScheduling)) {
        console.log(`[${chatId}] Job ${jobId} (${type}) wird übersprungen, da Ticker-Status ungültig oder geändert.`);
        activeWorkers--; 
        console.timeEnd(timerLabel);
        return;
    }

    console.log(`[${chatId}] Worker startet Job ${jobId} (${type}). Verbleibende Jobs: ${jobQueue.length}. Aktive Worker: ${activeWorkers}`);

    try {
        // 1. Get the game ID. 
        const effectiveGameId = gameId; // This is now correct for both job types
        if (!effectiveGameId) {
            throw new Error("Game ID konnte nicht ermittelt werden.");
        }
        
        // 2. Build the data URL
        const dataUrl = buildDataUrl(effectiveGameId);

        // 3. Fetch the data with Axios
        const metaRes = await axios.get(`${dataUrl}&_=${Date.now()}`, { timeout: 10000 });
        const gameData = metaRes.data.data; 
        const gameSummary = gameData.summary;

        if (!gameSummary || !gameData.events) {
            throw new Error("Ungültige Datenstruktur von API empfangen.");
        }

        // --- Logic for 'schedule' job ---
        if (type === 'schedule') {
            const scheduledTime = new Date(gameSummary.startsAt);
            const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000));
            const delay = startTime.getTime() - Date.now();
            const teamNames = { home: gameSummary.homeTeam.name, guest: gameSummary.awayTeam.name };
            const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

            tickerState.teamNames = teamNames;
            tickerState.lastUpdatedAt = gameSummary.updatedAt; 
            tickerState.meetingPageUrl = meetingPageUrl; // Save the original user-facing URL

            if (delay > 0) { // Still in future
                console.log(`[${chatId}] Planungs-Job erfolgreich...`);
                const modeDescriptionScheduled = (tickerState.mode === 'recap') ? `im Recap-Modus (${RECAP_INTERVAL_MINUTES}-Minuten-Zusammenfassungen)` : "mit Live-Updates";
                await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (${modeDescriptionScheduled}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);                
                tickerState.isPolling = false; 
                tickerState.isScheduled = true;
                
                const currentSchedule = loadScheduledTickers(scheduleFilePath);
                currentSchedule[chatId] = {
                    meetingPageUrl: tickerState.meetingPageUrl, // Save user-facing URL
                    startTime: startTime.toISOString(),
                    groupName: tickerState.groupName,
                    mode: tickerState.mode
                };
                saveScheduledTickers(currentSchedule, scheduleFilePath);
                tickerState.scheduleTimeout = setTimeout(() => beginActualPolling(chatId), delay);
            } else { // Already started
                console.log(`[${chatId}] Planungs-Job erfolgreich. Spiel beginnt sofort...`);
                let startMessage = `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet. `;
                startMessage += (tickerState.mode === 'recap') ? `Du erhältst alle ${RECAP_INTERVAL_MINUTES} Minuten eine Zusammenfassung. 📬` : `Du erhältst alle Events live! ⚽`;
                await client.sendMessage(chatId, startMessage);
                tickerState.isScheduling = false;
                beginActualPolling(chatId); 
            }
        }
        // --- Logic for 'poll' job ---
        else if (type === 'poll') {
             if (!tickerState.teamNames) { 
                 tickerState.teamNames = { home: gameSummary.homeTeam.name, guest: gameSummary.awayTeam.name }; 
             }
             
             const newUpdatedAt = gameSummary.updatedAt;
             if (newUpdatedAt && newUpdatedAt !== tickerState.lastUpdatedAt) {
                console.log(`[${chatId}] Neue Version erkannt: ${newUpdatedAt}`);
                tickerState.lastUpdatedAt = newUpdatedAt;
                
                if (await processEvents(gameData, tickerState, chatId)) {
                    saveSeenTickers(activeTickers, seenFilePath); 
                }
            } else {
                 console.log(`[${chatId}] Keine neue Version erkannt (${newUpdatedAt || 'N/A'}).`);
            }
        }
    } catch (error) {
        console.error(`[${chatId}] Fehler im Worker-Job ${jobId} (${type}):`, error.message);
        if (type === 'schedule') {
             await client.sendMessage(chatId, 'Fehler: Die initiale Planung des Tickers ist fehlgeschlagen. Bitte versuchen Sie es erneut.');
             activeTickers.delete(chatId);
             const currentSchedule = loadScheduledTickers(scheduleFilePath);
             if (currentSchedule[chatId]) {
                 delete currentSchedule[chatId];
                 saveScheduledTickers(currentSchedule, scheduleFilePath);
             }
        }
    } finally {
        console.timeEnd(timerLabel);
        activeWorkers--; 
    }
}

/**
 * Processes events, handles modes, calls AI, sends final stats, schedules cleanup.
 * (This function is unchanged)
 * @param {object} gameData - The full data object from the API (contains .summary, .events, .lineup).
 * @param {object} tickerState - The state object for the specific ticker.
 * @param {string} chatId - The WhatsApp chat ID.
 * @returns {boolean} - True if new, unseen events were processed, false otherwise.
 */
async function processEvents(gameData, tickerState, chatId) {
    if (!gameData || !Array.isArray(gameData.events)) return false;
    
    let newUnseenEventsProcessed = false;
    const gameSummary = gameData.summary; 
    
    // API sends events newest-first, so we reverse them
    const events = gameData.events.slice().reverse();

    for (const ev of events) {
        if (tickerState.seen.has(ev.id)) continue; 

        tickerState.seen.add(ev.id);
        newUnseenEventsProcessed = true;

        let msg = "";
        if (tickerState.mode === 'live') {
            msg = formatEvent(ev, tickerState, gameSummary);
        }

        if (tickerState.mode === 'live' && msg) {
            try {
                console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                await client.sendMessage(chatId, msg);
            } catch (sendError) {
                console.error(`[${chatId}] Fehler beim Senden der Nachricht für Event ${ev.id}:`, sendError);
            }
        }
        else if (tickerState.mode === 'recap') {
            const ignoredEvents = [];
            if (!ignoredEvents.includes(ev.type)) {
                console.log(`[${chatId}] Speichere Event-Objekt für Recap (ID: ${ev.id}, Typ: ${ev.type})`);
                tickerState.recapEvents = tickerState.recapEvents || [];
                tickerState.recapEvents.push(ev);
            }
        }
        
        const isCriticalEvent = (ev.type === "StopPeriod" || ev.type === "StartPeriod");
        if (isCriticalEvent && tickerState.mode === 'recap') {
            console.log(`[${chatId}] Kritisches Event (${ev.type}) erkannt, sende Recap sofort.`);
            await sendRecapMessage(chatId); 
        }

        if (ev.type === "StopPeriod") {
            const minute = ev.time ? parseInt(ev.time.split(':')[0], 10) : 0;
            if (minute > 30) { 
                console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
                tickerState.isPolling = false;
                if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);

                const index = jobQueue.findIndex(job => job.chatId === chatId);
                if (index > -1) jobQueue.splice(index, 1);

                try {
                    const statsMessage = await extractGameStats(gameData.lineup, tickerState.teamNames);
                    setTimeout(async () => {
                         try { await client.sendMessage(chatId, statsMessage); }
                         catch(e) { console.error(`[${chatId}] Fehler beim Senden der Spielstatistiken:`, e); }
                    }, 1000); 
                } catch (e) { console.error(`[${chatId}] Fehler beim Erstellen der Spielstatistiken:`, e); }

                try {
                    const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, gameData.lineup);
                    setTimeout(async () => {
                         if (summary) {
                             try { await client.sendMessage(chatId, summary); }
                             catch(e) { console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e); }
                         }
                    }, 2000); 
                } catch (e) { console.error(`[${chatId}] Fehler beim Generieren der AI-Zusammenfassung:`, e); }

                setTimeout(async () => {
                    const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/";
                    try { await client.sendMessage(chatId, finalMessage); }
                    catch (e) { console.error(`[${chatId}] Fehler beim Senden der Abschlussnachricht: `, e); }
                }, 4000); 

                setTimeout(() => {
                    if (activeTickers.has(chatId)) {
                        activeTickers.delete(chatId);
                        saveSeenTickers(activeTickers, seenFilePath);
                        console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                    }
                }, 3600000); 
                break; 
            }
        }
    }
    return newUnseenEventsProcessed;
}

// --- Exports ---
module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: queueTickerScheduling,
    beginActualPolling,
    getGameIdFromUrl // We need to export this for app.js
};