// ai.js 
const { GoogleGenAI } = require("@google/genai");

// The client gets the API key from the environment variable `GEMINI_API_KEY`.
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

/**
 * NEW: Helper function to find the top scorer(s) from a lineup array.
 * @param {Array} lineup - The lineup array (e.g., gameData.lineup.home).
 * @returns {string} - Formatted string of top scorer(s) (e.g., "Hauke Frahm (4 Tore)").
 */
function findTopScorer(lineup) {
    if (!lineup || lineup.length === 0) return "Niemand";

    let topScore = 0;
    lineup.forEach(player => {
        if (player.goals > topScore) {
            topScore = player.goals;
        }
    });

    if (topScore === 0) return "Niemand";

    const topScorers = lineup
        .filter(player => player.goals === topScore)
        .map(player => `${player.firstname} ${player.lastname}`);

    return `${topScorers.join(' & ')} (${topScore} Tore)`;
}

/**
 * NEW: Generates the stats object needed for the prompt.
 * @param {object} lineupData - The `gameData.lineup` object.
 * @returns {object} - An object with stats (topScorers, penalties, sevenMeters).
 */
function getStatsForPrompt(lineupData, teamNames) {
    // --- UPDATED to include blueCards ---
    const stats = {
        home: { name: teamNames.home, penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0, yellowCards: 0, redCards: 0, blueCards: 0 },
        guest: { name: teamNames.guest, penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0, yellowCards: 0, redCards: 0, blueCards: 0 }
    };

    // --- UPDATED to track blueCards separately ---
    lineupData.home.forEach(p => {
        stats.home.penalties += p.penalties || 0; 
        stats.home.sevenMetersMade += p.penaltyGoals || 0; 
        stats.home.sevenMetersMissed += p.penaltyMissed || 0; 
        stats.home.yellowCards += p.yellowCards || 0;
        stats.home.redCards += p.redCards || 0;
        stats.home.blueCards += p.blueCards || 0;
    });
    lineupData.away.forEach(p => {
        stats.guest.penalties += p.penalties || 0; 
        stats.guest.sevenMetersMade += p.penaltyGoals || 0; 
        stats.guest.sevenMetersMissed += p.penaltyMissed || 0; 
        stats.guest.yellowCards += p.yellowCards || 0;
        stats.guest.redCards += p.redCards || 0;
        stats.guest.blueCards += p.blueCards || 0;
    });

    // --- UPDATED to return new card stats ---
    return {
        homeTopScorer: findTopScorer(lineupData.home),
        guestTopScorer: findTopScorer(lineupData.away),
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
 * REWRITTEN: Extracts game stats from the `lineup` object and returns a formatted string.
 * This is called by polling.js to send the final stats message.
 * @param {object} lineupData - The `gameData.lineup` object (contains .home and .away arrays).
 * @param {object} teamNames - The team names object.
 * @returns {string} - A formatted WhatsApp message string with game stats.
 */
async function extractGameStats(lineupData, teamNames) {
    if (!lineupData || !lineupData.home || !lineupData.away) {
        console.log("Lineup-Daten für Statistiken nicht gefunden.");
        return "";
    }

    const gameStats = getStatsForPrompt(lineupData, teamNames);

    // --- NEW CLEANED-UP FORMAT ---
    let statsMessage = `📊 *Statistiken zum Spiel:*\n` +
                         `-----------------------------------\n` +
                         `*${teamNames.home}:*\n` +
                         `  - Topscorer: ${gameStats.homeTopScorer}\n` +
                         `  - 7-Meter: ${gameStats.homeSevenMeters}\n` +
                         `  - Zeitstrafen: ${gameStats.homePenalties}\n` +
                         `  - Gelbe Karten: ${gameStats.homeYellowCards}\n` +
                         `  - Rote Karten: ${gameStats.homeRedCards}\n`;

    // Only add blue cards if there were any
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
    
    // Only add blue cards if there were any
    if (gameStats.guestBlueCards > 0) {
        statsMessage += `  - Blaue Karten: ${gameStats.guestBlueCards}\n`;
    }
    
    return statsMessage.trim(); // .trim() removes any potential trailing newline
}


/**
 * REWRITTEN: Generates the AI game summary.
 * @param {Array} events - The chronological (reversed) list of events.
 * @param {object} teamNames - The team names object.
 *... (rest of prompt and function)
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

    const gameStats = getStatsForPrompt(lineupData, teamNames);

    // --- UPDATED to include new card stats in the prompt ---
    const prompt = `Du bist ein witziger, leicht sarkastischer und fachkundiger deutscher Handball-Kommentator.
    Deine Aufgabe ist es, eine kurze, unterhaltsame Zusammenfassung (ca. 2-4 Sätze) für ein gerade beendetes Spiel zu schreiben.

    WICHTIG: Die WhatsApp-Gruppe, in der du postest, heißt "${groupName}". Analysiere diesen Namen, um herauszufinden, welches Team du unterstützen sollst. 
    Falls der Gruppenname NICHT EINDEUTIG einem Team zuzuordnen ist, sei neutral und ignoriere den Grußennamen. Falls sich die Gruppe aber DEFINITIV einem Team zuzuordnen lässt, unterstütze das Team mit Herzblut und roaste auch gerne das gegnerische Team.
    
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
    3.  Sei kreativ, vermeide Standardflosfloskeln. Gib dem Kommentar Persönlichkeit! Vermeide Sachen aus den Daten zu interpretieren die nicht daraus zu erschließen sind, bleibe lieber bei den Fakten als eine "zu offensive Abwehr" zu erfinden. 
    4.  Falls Julian Langschwert, Tiard Brinkmann und/oder Simon Goßmann gespielt hat, lobe ihn sarkastisch bis in den Himmel.

    Deine Zusammenfassung (nur Überschrift und Text, ohne "Zusammenfassung:"):`;

    try {
        //const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        //const result = await model.generateContent(prompt);
        const response = await genAI.models.generateContent({
            model: "gemini-2.5-pro",
            contents: prompt,
        });
        
        return `🤖 *KI-Analyse zum Spiel:*\n\n${response.text}`;
    } catch (error) {
        console.error("Fehler bei der AI-Zusammenfassung:", error);
        return "";
    }
}

module.exports = { generateGameSummary, extractGameStats };