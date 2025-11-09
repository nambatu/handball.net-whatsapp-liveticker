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

// --- HELPER FUNCTIONS ---

/**
 * Abbreviates a player's name to the format "F. Lastname".
 * Handles "N.N." for unknown players by returning null.
 * @param {string|null} firstName - The player's first name.
 * @param {string|null} lastName - The player's last name.
 * @returns {string|null} - The abbreviated name, or null if no usable name.
 */
function abbreviatePlayerName(firstName, lastName) {
    const fName = firstName ? firstName.trim() : null;
    const lName = lastName ? lastName.trim() : null;

    if (fName === "N.N." && lName === "N.N.") {
        return null;
    }
    
    if (lName && fName && fName !== "N.N.") {
        const firstInitial = fName.split(' ')[0].charAt(0);
        return `${firstInitial}. ${lName}`;
    }
    if (lName && lName !== "N.N.") return lName;
    if (fName && fName !== "N.N.") return fName;
    
    return null; // Return null if no usable name
}

/**
 * Formats a game event object into a user-friendly WhatsApp message string for live mode.
 * @param {object} ev - The event object from the API.
 * @param {object} tickerState - The state object for the current ticker (contains team names).
 * @param {object} gameData - The full data object from the API (for lineup lookups).
 * @returns {string} - The formatted message string, or an empty string for ignored events.
 */
function formatEvent(ev, tickerState, gameData) {
    const eventInfo = EVENT_MAP[ev.type] || EVENT_MAP["default"];
    const homeTeamName = tickerState.teamNames ? tickerState.teamNames.home : 'Heim';
    const guestTeamName = tickerState.teamNames ? tickerState.teamNames.guest : 'Gast';
    
    const timeStr = ev.time ? ` (${ev.time})` : ''; 
    const lineup = gameData ? gameData.lineup : null;
    const team = ev.team ? ev.team.toLowerCase() : null; // 'home' or 'away'
    const teamName = ev.team === 'Home' ? homeTeamName : guestTeamName;

    // Helper to get player name or number
    const getPlayerTarget = () => {
        // --- FIX: Look for digits followed by a dot (e.g., "67." or "(76.)") ---
        const numMatch = ev.message.match(/(\d+)\./); 
        const playerNumber = numMatch ? parseInt(numMatch[1], 10) : null;
        let playerName = null;

        if (playerNumber && team && lineup && lineup[team]) {
            const player = lineup[team].find(p => p.number === playerNumber);
            if (player) {
                playerName = abbreviatePlayerName(player.firstname, player.lastname);
            }
        }
        
        if (playerName) return { name: playerName, isPlayer: true }; 
        if (playerNumber) return { name: `Nr. ${playerNumber}`, isPlayer: true }; 
        return { name: `*${teamName}*`, isPlayer: false }; 
    };

    const ageGroup = gameData?.summary?.ageGroup; 
    let emoji = eventInfo.emoji; 

    if (ev.type === "Goal") {
        emoji = (ageGroup === "Men") ? "🤾‍♂️" : "🤾‍♀️";
    }

    switch (ev.type) { 

        case "StartGame":
            return "";

        case "Goal":
        case "SevenMeterGoal": {
            let scoreLine;
            const [pointsHome, pointsGuest] = ev.score.replace('-', ':').split(':');
            
            if (ev.team === 'Home') {
                scoreLine = `${homeTeamName} *${pointsHome}*:${pointsGuest} ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName} ${pointsHome}:*${pointsGuest}* ${guestTeamName}`;
            }
            
            const target = getPlayerTarget();
            const msg = target.isPlayer ? `${eventInfo.label} durch ${target.name}` : eventInfo.label;
            return `${scoreLine}\n${emoji} ${msg}${timeStr}`;
        }

        case "SevenMeterMissed":
        case "TwoMinutePenalty":
        case "Warning":
        case "Disqualification":
        case "DisqualificationWithReport": {
            const target = getPlayerTarget();
            let msg;
            if (target.isPlayer) {
                msg = `${eventInfo.label} für ${target.name} (*${teamName}*)`;
            } else {
                msg = `${eventInfo.label} für ${target.name}`; 
            }
            return `${emoji} ${msg}${timeStr}`;
        }

        case "Timeout": 
            return `${emoji} ${eventInfo.label} für *${teamName}*${timeStr}`;

        case "StartPeriod": 
            if (ev.time === "00:00") {
                return `▶️ *Das Spiel hat begonnen!*`;
            } else {
                return `▶️ *Die zweite Halbzeit hat begonnen!*`;
            }       

        case "StopPeriod": {
            const [homeScore, awayScore] = ev.score.replace('-', ':').split(':');
            const minute = ev.time ? parseInt(ev.time.split(':')[0], 10) : 0;

            if (minute > 30) {
                 return `🏁 *Spielende*\n${homeTeamName} *${homeScore}:${awayScore}* ${guestTeamName}`;
            } else {
                 return `⏸️ *Halbzeit*\n${homeTeamName} *${homeScore}:${awayScore}* ${guestTeamName}`;
            }
        }

        default:
            return `${emoji} ${ev.message || eventInfo.label}${timeStr}`;
    }
}

/**
 * Formats a single event into a line for the recap message.
 * (REWRITTEN to be simpler)
 * @param {object} ev - The raw event object, including 'preformattedDetail'.
 * @param {object} tickerState - The state object for the ticker.
 * @returns {string} - The formatted recap line string.
 */
function formatRecapEventLine(ev, tickerState) {
    const eventInfo = EVENT_MAP[ev.type] || EVENT_MAP["default"];
    const time = ev.time || '--:--';
    let scoreStr = ev.score ? ev.score.replace('-', ':') : '--:--';
    
    // Use the preformattedDetail string we built in polling.js
    const detailStr = ev.preformattedDetail || ""; 

    const ageGroup = tickerState.ageGroup; 
    let emoji = eventInfo.emoji; 
    if (ev.type === "Goal") {
        emoji = (ageGroup === "Men") ? "🤾‍♂️" : "🤾‍♀️";
    }

    switch (ev.type) {
        case "StartGame":
            return "";
            
        case "Goal":
        case "SevenMeterGoal":
            const [home, away] = scoreStr.split(':');
            scoreStr = (ev.team === "Home") ? `*${home}*:${away}` : `${home}:*${away}*`;
            return `${emoji} ${time} | ${scoreStr} | ${detailStr}`;

        case "StartPeriod":
            return `${emoji} ${time} | *${detailStr}*`;
            
        case "StopPeriod":
            const [homeScore, awayScore] = scoreStr.split(':');
            return `${emoji} ${time} | *${detailStr}* | *${homeScore}:${awayScore}*`;

        default:
            // This now correctly handles penalties, misses, etc.
            return `${emoji} ${time} | ${scoreStr} | ${detailStr}`;
    }
}

// Export all functions needed by other modules
module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    abbreviatePlayerName, 
    formatEvent, 
    loadScheduledTickers,
    saveScheduledTickers,
    formatRecapEventLine
};