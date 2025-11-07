// polling.js
const axios = require('axios');
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers, formatRecapEventLine, abbreviatePlayerName } = require('./utils.js');
const { generateGameSummary, extractGameStats } = require('./ai.js');
const { EVENT_MAP } = require('./config.js');

// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1; 
let activeWorkers = 0; 
const MAX_WORKERS = 5; 
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

// --- HELPER FUNCTIONS (URL Parsers) ---

function looksLikeGameId(segment) {
    if (!segment) return false;
    return segment.includes('.') && /\d/.test(segment);
}

function getGameIdFromUrl(meetingPageUrl) {
    try {
        const url = new URL(meetingPageUrl);
        let pathname = url.pathname;

        if (pathname.endsWith('/')) {
            pathname = pathname.slice(0, -1);
        }

        const segments = pathname.split('/').filter(segment => segment.length > 0);
        let lastSegment = segments[segments.length - 1];

        if (looksLikeGameId(lastSegment)) {
            return lastSegment; 
        }

        segments.pop(); 
        let potentialId = segments[segments.length - 1];
        
        if (looksLikeGameId(potentialId)) {
            return potentialId; 
        }
        
        return null; 
    } catch (e) {
        console.error("Error parsing URL:", e.message);
        return null;
    }
}

function buildDataUrl(gameId) {
    return `https://www.handball.net/a/sportdata/1/games/${gameId}/combined?`;
}

async function getSpielplanData(teamPageUrl) {
    try {
        const response = await axios.get(teamPageUrl, { timeout: 10000 });
        const html = response.data;
        const regex = /"schedule":(\[.*?\]),"lastUpdated":/;
        const match = html.match(regex);

        if (match && match[1]) {
            return JSON.parse(match[1]); 
        }
        return null;
    } catch (error) {
        console.error("Fehler beim Abrufen der Spielplan-Daten:", error.message);
        throw new Error("Spielplan-Daten konnten nicht abgerufen werden.");
    }
}

// --- END HELPER FUNCTIONS ---


/**
 * Creates the initial ticker state and adds a 'schedule' job to the queue.
 */
async function queueTickerScheduling(meetingPageUrl, chatId, groupName, mode, isAutoSchedule = false, teamPageUrl = null) {
    const gameId = getGameIdFromUrl(meetingPageUrl);
    if (!gameId) {
        await client.sendMessage(chatId, `Fehler: Die URL ${meetingPageUrl} ist keine gültige Spiel-URL.`);
        return;
    }

    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = false; 
    tickerState.isScheduling = true;
    tickerState.meetingPageUrl = meetingPageUrl; 
    tickerState.gameId = gameId; 
    tickerState.groupName = groupName;
    tickerState.mode = mode;
    tickerState.recapEvents = []; 
    tickerState.isAutoSchedule = isAutoSchedule;
    tickerState.teamPageUrl = teamPageUrl; 
    activeTickers.set(chatId, tickerState); 

    jobQueue.push({
        type: 'schedule', 
        chatId,
        gameId: gameId, 
        meetingPageUrl: meetingPageUrl,
        groupName,
        mode,
        jobId: Date.now()
    });

    console.log(`[${chatId}] Planungs-Job für ${gameId} zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    if (!isAutoSchedule) { 
        await client.sendMessage(chatId, `⏳ Ticker-Planung für "${groupName}" wird bearbeitet...`);
    }
}

/**
 * NEW: Main function for the !autoschedule command.
 */
async function autoScheduleNextGame(teamPageUrl, chatId, groupName, mode) {
    const games = await getSpielplanData(teamPageUrl);
    if (!games || games.length === 0) {
        throw new Error("Konnte keine Spiele auf der Team-Seite finden.");
    }

    const nextGame = games.find(game => game.state === 'Pre');

    if (nextGame) {
        const gameUrl = `https://www.handball.net/spiele/${nextGame.id}`;
        await queueTickerScheduling(gameUrl, chatId, groupName, mode, true, teamPageUrl);
        return nextGame; 
    }
    
    return null; 
}


/**
 * Activates the actual polling loop for a ticker.
 * --- FIX: Initializes recapMinuteCounter ---
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

    // --- NEW: Initialize recap counter ---
    tickerState.recapMinuteCounter = 0;

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
        // --- NEW: Call sendRecapMessage which now handles its own timer logic ---
        tickerState.recapIntervalId = setInterval(() => {
            // Pass 'false' to indicate this is a timer call, not a critical event
            sendRecapMessage(chatId, false, null);
        }, RECAP_INTERVAL_MINUTES * 60 * 1000); 
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    if (!jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.unshift({
            type: 'poll', 
            chatId,
            gameId: tickerState.gameId, 
            tickerState: tickerState, 
            jobId: Date.now() 
        });
    }
}

/**
 * Sends a recap message.
 * --- FIX: Uses fixed 5-minute intervals for the title ---
 * @param {string} chatId - The WhatsApp chat ID.
 * @param {boolean} isCritical - Flag to indicate if this is a critical event trigger.
 * @param {object} event - The critical event object (if any).
 */
async function sendRecapMessage(chatId, isCritical = false, event = null) {
    const tickerState = activeTickers.get(chatId);
    
    // 1. Check if there is anything to send
    if (!tickerState || !tickerState.isPolling || (tickerState.recapEvents.length === 0 && !isCritical)) {
        // If it's a timer call and there are no events, just wait for the next timer
        if (!isCritical) {
            console.log(`[${chatId}] Kein Event für Recap gefunden. Überspringe.`);
            return; 
        }
    }

    // 2. Determine the title
    let timeRangeTitle;
    const startMin = tickerState.recapMinuteCounter || 0;

    if (isCritical) {
        // For critical events, title is "Start - Current Minute"
        const currentMinute = event ? parseInt(event.time.split(':')[0], 10) : startMin;
        timeRangeTitle = `Minute ${String(startMin).padStart(2, '0')} - ${String(currentMinute).padStart(2, '0')}`;
        // Update the counter to the critical event's time
        tickerState.recapMinuteCounter = currentMinute;
    } else {
        // For timer events, title is "Start - Start + 5"
        const endMin = startMin + RECAP_INTERVAL_MINUTES;
        timeRangeTitle = `Minute ${String(startMin).padStart(2, '0')} - ${String(endMin).padStart(2, '0')}`;
        // Update the counter for the next interval
        tickerState.recapMinuteCounter = endMin;
    }

    // 3. Get the events to send (everything in the buffer)
    const eventsToSend = [...tickerState.recapEvents];
    // If it's a critical event, add it to the list (it hasn't been added yet)
    if (isCritical && event) {
        eventsToSend.push(event);
    }
    
    if (eventsToSend.length === 0) {
        console.log(`[${chatId}] Kein Event für Recap ${timeRangeTitle} gefunden. Überspringe.`);
        return;
    }

    console.log(`[${chatId}] Sende ${eventsToSend.length} Events für Recap ${timeRangeTitle}.`);

    // 4. Build and send the message
    eventsToSend.sort((a, b) => a.timestamp - b.timestamp); 
    const recapLines = eventsToSend.map(ev => formatRecapEventLine(ev, tickerState));
    const validLines = recapLines.filter(line => line && line.trim() !== '');

    if (validLines.length === 0) {
        tickerState.recapEvents = []; // Clear buffer anyway
        return;
    }

    const teamHeader = `*${tickerState.teamNames.home}* : *${tickerState.teamNames.guest}*`;
    const recapBody = validLines.join('\n'); 
    const finalMessage = `📬 *${timeRangeTitle}*\n\n${teamHeader}\n${recapBody}`;

    try {
        await client.sendMessage(chatId, finalMessage);
        tickerState.recapEvents = []; // Clear buffer after successful send
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        tickerState.recapEvents = []; 
    }
}

/**
 * Master Scheduler: Runs periodically.
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
             gameId: tickerStateToPoll.gameId, 
             tickerState: tickerStateToPoll,
             jobId: Date.now()
        });
        console.log(`[${chatId}] Poll-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

/**
 * Dispatcher Loop: Runs frequently.
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
 * --- FIX: Initializes lastKnownScore ---
 */
async function runWorker(job) {
    const { chatId, jobId, type, gameId, meetingPageUrl } = job; 
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
        const effectiveGameId = gameId; 
        if (!effectiveGameId) {
            throw new Error("Game ID konnte nicht ermittelt werden.");
        }
        
        const dataUrl = buildDataUrl(effectiveGameId);
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
            tickerState.meetingPageUrl = meetingPageUrl; 
            tickerState.ageGroup = gameSummary.ageGroup; 
            // --- NEW: Initialize lastKnownScore ---
            tickerState.lastKnownScore = '0-0'; // Use API format

            if (delay > 0) { // Still in future
                console.log(`[${chatId}] Planungs-Job erfolgreich...`);
                const modeDescriptionScheduled = (tickerState.mode === 'recap') ? `im Recap-Modus (${RECAP_INTERVAL_MINUTES}-Minuten-Zusammenfassungen)` : "mit Live-Updates";
                
                if (!tickerState.isAutoSchedule) {
                    await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (${modeDescriptionScheduled}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);                
                }
                
                tickerState.isPolling = false; 
                tickerState.isScheduled = true;
                
                const currentSchedule = loadScheduledTickers(scheduleFilePath);
                currentSchedule[chatId] = {
                    meetingPageUrl: tickerState.meetingPageUrl, 
                    startTime: startTime.toISOString(),
                    groupName: tickerState.groupName,
                    mode: tickerState.mode,
                    isAutoSchedule: tickerState.isAutoSchedule,
                    teamPageUrl: tickerState.teamPageUrl,
                    ageGroup: tickerState.ageGroup 
                };
                saveScheduledTickers(currentSchedule, scheduleFilePath);
                tickerState.scheduleTimeout = setTimeout(() => beginActualPolling(chatId), delay);
            } else { // Already started
                console.log(`[${chatId}] Planungs-Job erfolgreich. Spiel beginnt sofort...`);
                let startMessage = `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet. `;
                startMessage += (tickerState.mode === 'recap') ? `Du erhältst alle ${RECAP_INTERVAL_MINUTES} Minuten eine Zusammenfassung. 📬` : `Du erhältst alle Events live! ⚽`;
                
                if (!tickerState.isAutoSchedule) {
                    await client.sendMessage(chatId, startMessage);
                }
                tickerState.isScheduling = false;
                beginActualPolling(chatId); 
            }
        }
        // --- Logic for 'poll' job ---
        else if (type === 'poll') {
             if (!tickerState.teamNames) { 
                 tickerState.teamNames = { home: gameSummary.homeTeam.name, guest: gameSummary.awayTeam.name }; 
             }
             if (!tickerState.ageGroup) {
                 tickerState.ageGroup = gameSummary.ageGroup;
             }
             if (!tickerState.lastKnownScore) {
                 tickerState.lastKnownScore = '0-0'; // Ensure it exists
             }
             
             const newUpdatedAt = gameSummary.updatedAt;
             if (!tickerState.lastUpdatedAt || newUpdatedAt > tickerState.lastUpdatedAt) { 
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
 * --- FIX: Handles lastKnownScore and fixed recap titles ---
 * @param {object} gameData - The full data object from the API.
 * @param {object} tickerState - The state object for the specific ticker.
 * @param {string} chatId - The WhatsApp chat ID.
 * @returns {boolean} - True if new, unseen events were processed, false otherwise.
 */
async function processEvents(gameData, tickerState, chatId) {
    if (!gameData || !Array.isArray(gameData.events)) return false;
    
    let newUnseenEventsProcessed = false;
    const events = gameData.events.slice().reverse();

    // --- NEW: Get last known score from state ---
    let lastKnownScore = tickerState.lastKnownScore || '0-0';

    for (const ev of events) {
        if (tickerState.seen.has(ev.id)) continue; 

        tickerState.seen.add(ev.id);
        newUnseenEventsProcessed = true;

        // Update lastKnownScore if this event has one
        if (ev.score) {
            lastKnownScore = ev.score;
        }

        // --- NEW: Inject the correct score into the event object *before* processing ---
        // This makes it available to both live and recap modes.
        const eventWithScore = { ...ev, score: ev.score || lastKnownScore };
        
        let msg = "";
        if (tickerState.mode === 'live') {
            msg = formatEvent(eventWithScore, tickerState, gameData); // Pass event with fixed score
        }

        if (tickerState.mode === 'live' && msg) {
            try {
                console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                await client.sendMessage(chatId, msg);
            } catch (sendError) {
                console.error(`[${chatId}] Fehler beim Senden der Nachricht für Event ${ev.id}:`, sendError);
            }
        }
        // Pre-format recap messages
        else if (tickerState.mode === 'recap') {
            const ignoredEvents = [];
            if (!ignoredEvents.includes(ev.type)) {
                
                const lineup = gameData ? gameData.lineup : null;
                const team = ev.team ? ev.team.toLowerCase() : null; 
                const teamName = ev.team === 'Home' ? tickerState.teamNames.home : tickerState.teamNames.guest;

                let detailStr = ""; 
                const numMatch = ev.message.match(/(\d+)\./);
                const playerNumber = numMatch ? parseInt(numMatch[1], 10) : null;
                let playerName = null;

                if (playerNumber && team && lineup && lineup[team]) {
                    const player = lineup[team].find(p => p.number === playerNumber);
                    if (player) {
                        playerName = abbreviatePlayerName(player.firstname, player.lastname); 
                    }
                }

                switch (ev.type) {
                    case "Goal":
                    case "SevenMeterGoal":
                        if (playerName) detailStr = `${playerName}`;
                        else if (playerNumber) detailStr = `Nr. ${playerNumber}`;
                        break;
                    case "SevenMeterMissed":
                    case "TwoMinutePenalty":
                    case "Warning":
                    case "Disqualification":
                    case "DisqualificationWithReport":
                        if (playerName) detailStr = `${playerName} (*${teamName}*)`;
                        else if (playerNumber) detailStr = `Nr. ${playerNumber} (*${teamName}*)`;
                        else detailStr = `*${teamName}*`;
                        break;
                    case "Timeout":
                        detailStr = `*${teamName}*`;
                        break;
                    case "StartPeriod":
                        detailStr = (ev.time === "00:00") ? "Das Spiel hat begonnen!" : "Die zweite Halbzeit hat begonnen!";
                        break;
                    case "StopPeriod":
                         const minute = ev.time ? parseInt(ev.time.split(':')[0], 10) : 0;
                         if (minute > 30) detailStr = `Spielende`;
                         else detailStr = `Halbzeit`;
                        break;
                    default:
                        detailStr = ""; 
                }
                
                console.log(`[${chatId}] Speichere Event-Objekt für Recap (ID: ${ev.id}, Typ: ${ev.type})`);
                // Push the event *with* the fixed score and preformatted detail
                tickerState.recapEvents.push({ ...eventWithScore, preformattedDetail: detailStr });
            }
        }
        
        // --- UPDATED: Reset timer on critical event ---
        const isCriticalEvent = (ev.type === "StopPeriod" || ev.type === "StartPeriod");
        if (isCriticalEvent && tickerState.mode === 'recap') {
            console.log(`[${chatId}] Kritisches Event (${ev.type}) erkannt, sende Recap sofort und setze Timer zurück.`);
            
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
            // Pass 'true' and the event to the recap function
            await sendRecapMessage(chatId, true, eventWithScore); 
            
            tickerState.recapIntervalId = setInterval(() => {
                sendRecapMessage(chatId, false, null);
            }, RECAP_INTERVAL_MINUTES * 60 * 1000); 
        }
        // --- END UPDATE ---

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
                    const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/handball.net-whatsapp-liveticker-bot/";
                    try { await client.sendMessage(chatId, finalMessage); }
                    catch (e) { console.error(`[${chatId}] Fehler beim Senden der Abschlussnachricht: `, e); }
                }, 4000); 

                // SCHEDULE CLEANUP & AUTO-SCHEDULE HOOK
                setTimeout(async () => {
                    if (activeTickers.has(chatId)) {
                        activeTickers.delete(chatId);
                        saveSeenTickers(activeTickers, seenFilePath);
                        console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                    }
                    
                    if (tickerState.isAutoSchedule) {
                        console.log(`[${chatId}] Auto-Schedule: Suche nach dem nächsten Spiel...`);
                        try {
                            const nextGame = await autoScheduleNextGame(tickerState.teamPageUrl, chatId, tickerState.groupName, tickerState.mode);
                            if (nextGame) {
                                await client.sendMessage(chatId, `🤖 Auto-Schedule: Das nächste Spiel wurde gefunden und geplant:\n\n*${nextGame.homeTeam.name}* vs *${nextGame.awayTeam.name}*\nam ${new Date(nextGame.startsAt).toLocaleDateString('de-DE', {weekday: 'short', day: '2-digit', month: '2-digit'})} um ${new Date(nextGame.startsAt).toLocaleTimeString('de-DE', {hour: '2-digit', minute: '2-digit'})} Uhr.`);
                            } else {
                                await client.sendMessage(chatId, `🤖 Auto-Schedule: Alle Spiele für diese Saison sind abgeschlossen. Die automatische Planung ist beendet.`);
                            }
                        } catch (e) {
                            console.error(`[${chatId}] Auto-Schedule-Fehler:`, e);
                            await client.sendMessage(chatId, `🤖 Auto-Schedule: Fehler beim Planen des nächsten Spiels: ${e.message}`);
                        }
                    }
                    
                }, 30000); 
                break; 
            }
        }
    }
    
    // --- NEW: Save the last known score for the next poll ---
    tickerState.lastKnownScore = lastKnownScore;
    
    return newUnseenEventsProcessed;
}

// --- Exports ---
module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: queueTickerScheduling,
    beginActualPolling,
    getGameIdFromUrl,
    autoScheduleNextGame 
};