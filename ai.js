// ai.js 
const { GoogleGenAI } = require("@google/genai");

// The client gets the API key from the environment variable `GEMINI_API_KEY`.
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

/**
 * --- REWRITTEN to calculate top scorer from the EVENTS array ---
 * @param {Array} lineup - The lineup array for this team (e.g., gameData.lineup.home).
 * @param {Array} events - The *full* chronological list of game events.
 * @param {string} teamSide - The team to check, either 'Home' or 'Away'.
 * @returns {string} - Formatted string of top scorer(s).
 */
function findTopScorer(lineup, events, teamSide) {
    if (!lineup || lineup.length === 0) return "Niemand";
    if (!events || events.length === 0) return "Niemand";

    const goalMap = new Map(); // <playerNumber, goalCount>
    let topScore = 0;

    // 1. Loop through all events and count goals for this team
    for (const ev of events) {
        // Only count goals for the specified team
        if (ev.team !== teamSide) continue;
        
        if (ev.type === "Goal" || ev.type === "SevenMeterGoal") {
            // Extract player number from message (e.g., "Tor durch 10." or "Tor (7m) durch 22.")
            const numMatch = ev.message.match(/(\d+)\./); 
            const playerNumber = numMatch ? parseInt(numMatch[1], 10) : null;

            if (playerNumber) {
                const newScore = (goalMap.get(playerNumber) || 0) + 1;
                goalMap.set(playerNumber, newScore);
                if (newScore > topScore) {
                    topScore = newScore;
                }
            }
        }
    }

    if (topScore === 0) return "Niemand";

    // 2. Find all players who match the top score
    const topScorerNumbers = [];
    for (const [playerNumber, score] of goalMap.entries()) {
        if (score === topScore) {
            topScorerNumbers.push(playerNumber);
        }
    }
    
    // 3. Map numbers back to names using the lineup array
    const topScorers = topScorerNumbers.map(number => {
        const player = lineup.find(p => p.number === number);
        if (player) {
            // --- FIX: Use correct camelCase properties ---
            const fName = player.firstname ? player.firstname.trim() : null;
            const lName = player.lastname ? player.lastname.trim() : null;
            
            if (lName && fName && fName !== "N.N.") {
                // Using full first name + last name for clarity in stats
                return `${fName.split(' ')[0]} ${lName}`; 
            }
            if (lName && lName !== "N.N.") return lName;
            if (fName && fName !== "N.N.") return fName;
        }
        return `Nr. ${number}`; // Fallback if player not in lineup
    });

    return `${topScorers.join(' & ')} (${topScore} Tore)`;
}

/**
 * --- REWRITTEN to calculate stats from the EVENTS array ---
 * @param {object} lineupData - The `gameData.lineup` object (for top scorer only).
 * @param {object} teamNames - The team names object.
 * @param {Array} events - The chronological list of all game events.
 * @returns {object} - An object with correctly counted stats.
 */
function getStatsForPrompt(lineupData, teamNames, events) {
    const stats = {
        home: { name: teamNames.home, penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0, yellowCards: 0, redCards: 0, blueCards: 0 },
        guest: { name: teamNames.guest, penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0, yellowCards: 0, redCards: 0, blueCards: 0 }
    };

    // --- NEW: Calculate stats by looping through the event log ---
    for (const ev of events) {
        const targetTeam = (ev.team === 'Home') ? stats.home : stats.guest;
        if (!targetTeam) continue;

        switch (ev.type) {
            case "SevenMeterGoal":
                targetTeam.sevenMetersMade++;
                break;
            case "SevenMeterMissed":
                targetTeam.sevenMetersMissed++;
                break;
            case "TwoMinutePenalty":
                targetTeam.penalties++;
                break;
            case "Warning":
                targetTeam.yellowCards++;
                break;
            case "Disqualification":
                targetTeam.redCards++;
                break;
            case "DisqualificationWithReport":
                targetTeam.blueCards++;
                break;
        }
    }
    // --- END NEW ---

    return {
        // --- FIX: Pass events and team side to the new findTopScorer ---
        homeTopScorer: findTopScorer(lineupData.home, events, 'Home'),
        guestTopScorer: findTopScorer(lineupData.away, events, 'Away'),
        
        // All other stats are now from our reliable event count
        homePenalties: stats.home.penalties,
        guestPenalties: stats.guest.penalties,
        homeSevenMeters: `${stats.home.sevenMetersMade} von ${stats.home.sevenMetersMade + stats.home.sevenMetersMissed}`,
        guestSevenMeters: `${stats.guest.sevenMetersMade} von ${stats.guest.sevenMetersMade + stats.guest.sevenMetersMissed}`,
        homeYellowCards: stats.home.yellowCards,
        guestYellowCards: stats.guest.yellowCards,
        homeRedCards: stats.home.redCards,
        guestRedCards: stats.guest.redCards,
        homeBlueCards: stats.home.blueCards,
        guestBlueCards: stats.guest.blueCards
    };
}


/**
 * REWRITTEN: Extracts game stats. Now requires the 'events' array.
 * @param {object} lineupData - The `gameData.lineup` object (for top scorer).
 * @param {object} teamNames - The team names object.
 * @param {Array} events - The chronological list of all game events.
 * @returns {string} - A formatted WhatsApp message string with game stats.
 */
async function extractGameStats(lineupData, teamNames, events) {
    if (!lineupData || !lineupData.home || !lineupData.away) {
        console.log("Lineup-Daten für Statistiken nicht gefunden.");
        return "";
    }
    if (!events || events.length === 0) {
         console.log("Event-Daten für Statistiken nicht gefunden.");
        return ""; // Can't count stats without events
    }

    const gameStats = getStatsForPrompt(lineupData, teamNames, events);

    let statsMessage = `📊 *Statistiken zum Spiel:*\n` +
                         `-----------------------------------\n` +
                         `*${teamNames.home}:*\n` +
                         `  - Topscorer: ${gameStats.homeTopScorer}\n` +
                         `  - 7-Meter: ${gameStats.homeSevenMeters}\n` +
                         `  - Zeitstrafen: ${gameStats.homePenalties}\n` +
                         `  - Gelbe Karten: ${gameStats.homeYellowCards}\n` +
                         `  - Rote Karten: ${gameStats.homeRedCards}\n`;

    if (gameStats.homeBlueCards > 0) {
        statsMessage += `  - Blaue Karten: ${gameStats.homeBlueCards}\n`;
    }

    statsMessage += `-----------------------------------\n` +
                    `*${teamNames.guest}:*\n` +
                    `  - Topscorer: ${gameStats.guestTopScorer}\n` +
                    `  - 7-Meter: ${gameStats.guestSevenMeters}\n` +
                    `  - Zeitstrafen: ${gameStats.guestPenalties}\n` +
                    `  - Gelbe Karten: ${gameStats.guestYellowCards}\n` +
                    `  - Rote Karten: ${gameStats.guestRedCards}\n`;
    
    if (gameStats.guestBlueCards > 0) {
        statsMessage += `  - Blaue Karten: ${gameStats.guestBlueCards}\n`;
    }
    
    return statsMessage.trim();
}


/**
 * REWRITTEN: Generates the AI game summary with fallback logic.
 * (Now uses the recalculated stats)
 * @param {Array} events - The chronological (reversed) list of events.
 * @param {object} teamNames - The team names object.
 * @param {string} groupName - The name of the WhatsApp group.
 * @param {object} lineupData - The `gameData.lineup` object (for top scorer).
 * @returns {string} - The formatted AI summary message.
 */
async function generateGameSummary(events, teamNames, groupName, lineupData) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("GEMINI_API_KEY nicht gefunden. KI-Zusammenfassung wird übersprungen.");
        return "";
    }

    const finalEvent = events.find(e => e.type === "StopPeriod" && parseInt(e.time.split(':')[0], 10) > 30);
    const halftimeEvent = events.find(e => e.type === "StopPeriod" && parseInt(e.time.split(':')[0], 10) <= 30);

    const finalScore = finalEvent ? finalEvent.score.replace('-', ':') : "N/A";
    const halftimeScore = halftimeEvent ? halftimeEvent.score.replace('-', ':') : "N/A";
    const gameDurationMinutes = finalEvent ? parseInt(finalEvent.time.split(':')[0], 10) : 60;

    let scoreProgression = "Start: 0:0";
    for (let minute = 10; minute <= gameDurationMinutes; minute += 10) {
        const eventAtTime = [...events].reverse().find(e => {
            if (!e.time) return false; 
            const evMinute = parseInt(e.time.split(':')[0], 10);
            return evMinute <= minute && e.score;
        });
        
        if (eventAtTime) {
            scoreProgression += `, ${minute}min: ${eventAtTime.score.replace('-', ':')}`;
        }
    }

    const gameStats = getStatsForPrompt(lineupData, teamNames, events);

    const prompt = `Du bist ein witziger, leicht sarkastischer und fachkundiger deutscher Handball-Kommentator.
    Deine Aufgabe ist es, eine kurze, unterhaltsame Zusammenfassung (ca. 2-4 Sätze) für ein gerade beendetes Spiel zu schreiben.

    WICHTIG: Die WhatsApp-Gruppe, in der du postest, heißt "${groupName}". Analysiere diesen Namen, um herauszufinden, welches Team du unterstützen sollst. 
    Falls der Gruppenname NICHT EINDEUTIG einem Team zuzuordnen ist, sei neutral und ignoriere den Grußennamen. Falls sich die Gruppe aber DEFINITIV einem Team zuordnen lässt, unterstütze das Team mit Herzblut und roaste auch gerne das gegnerische Team.
    
    Hier sind die Spieldaten:
    - Heimmannschaft: ${teamNames.home}
    - Gastmannschaft: ${teamNames.guest}
    - Halbzeitstand: ${halftimeScore}
    - Endstand: ${finalScore}
    - Spiellänge: ${gameDurationMinutes} Minuten
    - Spielverlauf (ausgewählte Spielstände): ${scoreProgression}, Ende: ${finalScore}
    - Topscorer ${teamNames.home}: ${gameStats.homeTopScorer}
    - Topscorer ${teamNames.guest}: ${gameStats.guestTopScorer}
    - 7-Meter ${teamNames.home}: ${gameStats.homeSevenMeters}
    - 7-Meter ${teamNames.guest}: ${gameStats.guestSevenMeters}
    - Zeitstrafen ${teamNames.home}: ${gameStats.homePenalties}
    - Zeitstrafen ${teamNames.guest}: ${gameStats.guestPenalties}
    - Gelbe Karten ${teamNames.home}: ${gameStats.homeYellowCards}
    - Gelbe Karten ${teamNames.guest}: ${gameStats.guestYellowCards}
    - Rote Karten ${teamNames.home}: ${gameStats.homeRedCards}
    - Rote Karten ${teamNames.guest}: ${gameStats.guestRedCards}
    - Blaue Karten ${teamNames.home}: ${gameStats.homeBlueCards}
    - Blaue Karten ${teamNames.guest}: ${gameStats.guestBlueCards}

    Anweisungen:
    1.  Gib deiner Zusammenfassung eine kreative, reißerische Überschrift in Fett (z.B. *Herzschlagfinale in der Halle West!* oder *Eine Lehrstunde in Sachen Abwehrschlacht.*).
    2.  Verwende die Statistiken für spitze Kommentare. (z.B. "Mit ${gameStats.guestPenalties} Zeitstrafen hat sich Team Gast das Leben selbst schwer gemacht." oder "Am Ende hat die Kaltschnäuzigkeit vom 7-Meter-Punkt den Unterschied gemacht."). Verwende die Statistiken nur, wenn sie auch sinnvoll oder wichtig für das Spiel waren.
    3.  Sei kreativ, vermeide Standardfloskeln. Gib dem Kommentar Persönlichkeit! Vermeide Sachen aus den Daten zu interpretieren die nicht daraus zu erschließen sind, bleibe lieber bei den Fakten als eine "zu offensive Abwehr" zu erfinden. 
    4.  Falls Julian Langschwert, Tiard Brinkmann oder Simon Goßmann gespielt hat, lobe die jeweilige Person sarkastisch bis in den Himmel.

    Deine Zusammenfassung (nur Überschrift und Text, ohne "Zusammenfassung:"):`;

    // --- NEW FALLBACK LOGIC ---
    try {
        // 1. Try the "pro" model first
        console.log("Versuche AI-Zusammenfassung mit 'gemini-2.5-pro'...");
        const responsePro = await genAI.models.generateContent({
            model: "gemini-2.5-pro",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
        });
        
        return `🤖 *KI-Analyse zum Spiel:*\n\n${responsePro.text()}`;

    } catch (error) {
        console.warn(`Fehler bei 'gemini-2.5-pro': ${error.status} ${error.message}`);
        
        // 2. If it's an overload error, try the "flash" model
        if (error.status === 503 || (error.message && error.message.includes("overloaded"))) {
            console.log("Pro-Modell überlastet. Versuche Fallback mit 'gemini-2.5-flash'...");
            try {
                const responseFlash = await genAI.models.generateContent({
                    model: "gemini-2.5-flash",
                    contents: [{ role: "user", parts: [{ text: prompt }] }],
                });
                
                return `🤖 *KI-Analyse zum Spiel (Flash-Modell):*\n\n${responseFlash.text()}`;
                
            } catch (flashError) {
                // 3. If "flash" also fails, send the user-facing error
                console.error("Fehler bei der AI-Zusammenfassung (Flash-Fallback):", flashError);
                return "🤖 *KI-Analyse zum Spiel:*\n\nDas KI-Modell ist derzeit überlastet. Zur Zeit ist leider keine Analyse möglich.";
            }
        }
        
        // 4. If it was a different error (not 503), send the user-facing error
        console.error("Fehler bei der AI-Zusammenfassung (Pro-Modell):", error);
        return "🤖 *KI-Analyse zum Spiel:*\n\nDas KI-Modell ist derzeit überlastet. Zur Zeit ist leider keine Analyse möglich.";
    }
}

module.exports = { generateGameSummary, extractGameStats };