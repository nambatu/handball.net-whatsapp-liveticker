// utils.js

const fs = require('fs');
const path = require('path');
const { EVENT_MAP } = require('./config.js'); // Import event definitions

// --- DATA PERSISTENCE (UNCHANGED) ---

function loadSeenTickers(activeTickers, seenFilePath) {
    try {
        const raw = fs.readFileSync(seenFilePath, 'utf8'); 
        const data = JSON.parse(raw); 
        for (const [chatId, seenArray] of Object.entries(data)) {
            if (!activeTickers.has(chatId)) {
                activeTickers.set(chatId, { seen: new Set(seenArray) }); 
            } else {
                const existingState = activeTickers.get(chatId);
                existingState.seen = new Set(seenArray);
            }
        }
        console.log(`Daten für ${Object.keys(data).length} Ticker aus der Datei geladen.`);
    } catch (e) {
        console.log('Keine gespeicherte Ticker-Datei gefunden oder Fehler beim Lesen, starte frisch.');
    }
}

function saveSeenTickers(activeTickers, seenFilePath) {
    try {
        const dataToSave = {};
        for (const [chatId, tickerState] of activeTickers.entries()) {
            if (tickerState.seen) {
                dataToSave[chatId] = [...tickerState.seen];
            }
        }
        fs.writeFileSync(seenFilePath, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (e) {
        console.error('Fehler beim Speichern der Ticker-Daten:', e);
    }
}

function loadScheduledTickers(scheduleFilePath) {
    try {
        const raw = fs.readFileSync(scheduleFilePath, 'utf8');
        return JSON.parse(raw); 
    } catch (e) {
        console.log('Keine gespeicherte Planungsdatei gefunden oder Fehler beim Lesen.');
        return {}; 
    }
}

function saveScheduledTickers(scheduledTickers, scheduleFilePath) {
    try {
        fs.writeFileSync(scheduleFilePath, JSON.stringify(scheduledTickers, null, 2), 'utf8');
    } catch (e) {
        console.error('Fehler beim Speichern der geplanten Ticker:', e);
    }
}

// --- HELPER FUNCTIONS (RE-ADD ABBREVIATE) ---

/**
 * Abbreviates a player's name to the format "F. Lastname".
 * @param {string|null} firstName - The player's first name.
 * @param {string|null} lastName - The player's last name.
 * @returns {string} - The abbreviated name, or just the last name, or an empty string.
 */
function abbreviatePlayerName(firstName, lastName) {
    if (!lastName) return firstName || ''; // Handle missing last name
    if (!firstName) return lastName; // Handle missing first name
    
    // Handle multiple first names (e.g., "Thore Kjell")
    const firstInitial = firstName.split(' ')[0].charAt(0);
    
    return `${firstInitial}. ${lastName}`;
}

/**
 * Formats a game event object into a user-friendly WhatsApp message string for live mode.
 * (REWRITTEN to build messages manually)
 * @param {object} ev - The event object from the API.
 * @param {object} tickerState - The state object for the current ticker (contains team names).
 * @param {object} gameData - The full data object from the API (for lineup lookups).
 * @returns {string} - The formatted message string, or an empty string for ignored events.
 */
function formatEvent(ev, tickerState, gameData) {
    const eventInfo = EVENT_MAP[ev.type] || EVENT_MAP["default"];
    const homeTeamName = tickerState.teamNames ? tickerState.teamNames.home : 'Heim';
    const guestTeamName = tickerState.teamNames ? tickerState.teamNames.guest : 'Gast';
    
    const timeStr = ev.time ? ` (${ev.time})` : ''; // This is the correct time
    const lineup = gameData ? gameData.lineup : null;
    const team = ev.team ? ev.team.toLowerCase() : null; // 'home' or 'away'

    // Helper to find player and build new message
    const getFormattedPlayerMessage = () => {
        // Regex to find the player number like (15.)
        const numMatch = ev.message.match(/\((\d+)\.\)/);
        const playerNumber = numMatch ? parseInt(numMatch[1], 10) : null;

        let player = null;
        if (playerNumber && team && lineup && lineup[team]) {
            player = lineup[team].find(p => p.number === playerNumber);
        }

        if (player) {
            const abbreviatedName = abbreviatePlayerName(player.firstname, player.lastname);
            
            // Check if name is at the start or end of the original message
            // "Tor durch Ana Walk (15.) (TV Schriesheim)"
            if (ev.message.startsWith(eventInfo.label) || ev.message.startsWith("7-Meter")) {
                 return `${eventInfo.label} durch ${abbreviatedName.trim()}`;
            } 
            // "Lukas Friedhoff (6.) (MTV Braunschweig) erhält eine 2-Minuten Strafe"
            else {
                 // Rebuild based on event type
                 switch (ev.type) {
                     case "TwoMinutePenalty":
                         return `${abbreviatedName.trim()} erhält eine Zeitstrafe`;
                     case "Warning":
                         return `${abbreviatedName.trim()} erhält eine Verwarnung`;
                     case "Disqualification":
                         return `${abbreviatedName.trim()} erhält eine Rote Karte`;
                     case "DisqualificationWithReport":
                         return `${abbreviatedName.trim()} erhält eine Blaue Karte`;
                     default:
                         return `${eventInfo.label} durch ${abbreviatedName.trim()}`;
                 }
            }
        } else {
            // Fallback: Can't find player, just clean up the old message
            let cleanedMessage = ev.message;
            cleanedMessage = cleanedMessage.replace(/\s\([^)]*?\)$/, ''); // Remove team
            cleanedMessage = cleanedMessage.replace(/\s\(\d+\.\)/, ''); // Remove number
            return cleanedMessage;
        }
    };


    switch (ev.type) { 
        case "Goal":
        case "SevenMeterGoal": {
            let scoreLine;
            const [pointsHome, pointsGuest] = ev.score.split(':');
            if (ev.team === 'Home') {
                scoreLine = `${homeTeamName}  *${pointsHome}*:${pointsGuest}  ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName}  ${pointsHome}:*${pointsGuest}* ${guestTeamName}`;
            }
            
            const formattedMessage = getFormattedPlayerMessage();
            return `${scoreLine}\n${eventInfo.emoji} ${formattedMessage}${timeStr}`;
        }

        case "SevenMeterMissed":
        case "TwoMinutePenalty":
        case "Warning":
        case "Disqualification":
        case "DisqualificationWithReport": {
            const formattedMessage = getFormattedPlayerMessage();
            return `${eventInfo.emoji} ${formattedMessage}${timeStr}`;
        }

        case "Timeout": 
            // This message doesn't have a player name, so we just use it
            return `${eventInfo.emoji} ${ev.message}${timeStr}`;

        case "StartPeriod": 
            if (ev.time === "00:00") {
                return `▶️ *Das Spiel hat begonnen!*`;
            } else {
                return `▶️ *Die zweite Halbzeit hat begonnen!*`;
            }       

        case "StopPeriod": {
            const [homeScore, awayScore] = ev.score.split(':');
            const minute = ev.time ? parseInt(ev.time.split(':')[0], 10) : 0;

            if (minute > 30) {
                 return `🏁 *Spielende*\n${homeTeamName}  *${homeScore}:${awayScore}* ${guestTeamName}`;
            } else {
                 return `⏸️ *Halbzeit*\n${homeTeamName}  *${homeScore}:${awayScore}* ${guestTeamName}`;
            }
        }

        default:
            return `${eventInfo.emoji} ${ev.message || eventInfo.label}${timeStr}`;
    }
}

/**
 * Formats a single event into a line for the recap message (Emoji-only version).
 * (This is unchanged, but we leave it here)
 * @param {object} ev - The raw event object from the `handball.net` API.
 * @param {object} tickerState - The state object for the ticker.
 * @returns {string} - The formatted recap line string.
 */
function formatRecapEventLine(ev, tickerState) {
    const eventInfo = EVENT_MAP[ev.type] || EVENT_MAP["default"];
    const time = ev.time || '--:--';
    let scoreStr = ev.score ? ev.score.replace('-', ':') : '--:--';
    const detailStr = ev.message || eventInfo.label;

    switch (ev.type) {
        case "Goal":
        case "SevenMeterGoal":
            const [home, away] = scoreStr.split(':');
            scoreStr = (ev.team === "Home") ? `*${home}*:${away}` : `${home}:*${away}*`;
            return `${eventInfo.emoji} ${time} | ${scoreStr} | ${detailStr}`;

        case "StartPeriod":
        case "StopPeriod":
            return `${eventInfo.emoji} ${time} | *${detailStr}* | *${scoreStr}*`;

        default:
            return `${eventInfo.emoji} ${time} | ${scoreStr} | ${detailStr}`;
    }
}

// Export all functions needed by other modules
module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    formatEvent, // For live mode and critical events
    loadScheduledTickers,
    saveScheduledTickers,
    formatRecapEventLine // For recap mode messages
};