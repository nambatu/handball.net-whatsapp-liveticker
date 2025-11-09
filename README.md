# WhatsApp Live Ticker Bot (handball.net)

Das ist ein WhatsApp-Bot, der Live-Ticker-Daten von `handball.net` in Echtzeit in deine WhatsApp-Gruppe schickt. 

## Features

  * **Zwei Ticker-Modi:**
      * **Live-Modus:** Sendet *jedes* Ereignis (Tor, 7-Meter, Zeitstrafe) sofort als einzelne Nachricht.
      * **Recap-Modus:** Schickt alle 5 Minuten eine Zusammenfassung der letzten Ereignisse (ideal für Chats, die nicht "zugespammt" werden sollen).
  * **Auto-Schedule:** Plant automatisch das nächste anstehende Spiel einer Mannschaft. Sobald das Spiel vorbei ist, sucht der Bot das nächste Spiel der Saison und plant es von selbst.
  * **KI-Zusammenfassung:** Nach dem Spiel schreibt ein sarkastischer KI-Kommentator (powered by Google Gemini) eine witzige, personalisierte Zusammenfassung des Spiels.
  * **Detaillierte Statistiken:** Postet nach Abpfiff eine komplette Übersicht der Spielstatistiken, inklusive Torschützenkönigen, 7-Meter-Quoten und allen Strafen.
  * **Clevere Zeitplanung:** Du kannst den Ticker schon Stunden vorher starten. Der Bot liest die offizielle Startzeit und legt von selbst ein paar Minuten vor Anpfiff los.
  * **Dauerbetrieb:** Der Bot speichert alle geplanten Ticker und gesehenen Events. Wenn du den Bot neustartest, macht er genau da weiter, wo er aufgehört hat.

-----

Du willst den Bot für dein Team nutzen, aber hast keine Lust, ihn selbst zu hosten? Kein Problem\! Ich kann den Ticker für dein Team auf meinem Raspberry Pi einrichten. Schreib mir einfach eine E-Mail an: **julianlangschwert@gmail.com**

## Setup-Anleitung

Der Bot ist dafür ausgelegt, 24/7 auf einem Server (z.B. einem Raspberry Pi) zu laufen.

### Voraussetzungen

  * Ein Server (Raspberry Pi 4 empfohlen) mit Raspberry Pi OS oder einem anderen Linux.
  * [Node.js](https://nodejs.org/) (Version 16 oder neuer).
  * [Git](https://git-scm.com/) muss installiert sein.
  * [Chromium](https://www.chromium.org/): `whatsapp-web.js` braucht einen Browser.
  * Ein **eigener WhatsApp-Account** (es wird dringend empfohlen, eine separate Nummer dafür zu nutzen).
  * Ein **Google Gemini API Key** für die KI-Zusammenfassungen.

### 1\. Installation

1.  **Repository klonen**

    ```bash
    # Führe das in deinem Home-Verzeichnis aus
    git clone [URL_ZU_DEINEM_GIT_REPO] handball-net-bot
    cd handball-net-bot
    ```

2.  **Abhängigkeiten installieren**
    Das installiert alle nötigen Node.js-Pakete.

    ```bash
    npm install
    ```

3.  **System-Pakete installieren**
    Wir installieren `pm2` (einen Prozess-Manager) und `chromium` (für WhatsApp Web).

    ```bash
    # PM2 global installieren
    sudo npm install pm2 -g

    # Chromium-Browser installieren
    sudo apt update
    sudo apt install -y chromium
    ```

### 2\. Konfiguration

Du musst eine `.env` Datei erstellen, um deinen API-Key zu speichern.

1.  **`.env` Datei erstellen:**

    ```bash
    nano .env
    ```

2.  **Key eintragen:**
    Kopier die folgende Zeile in den Editor und ersetze den Platzhalter mit deinem Key:

    ```
    GEMINI_API_KEY="DEIN_API_KEY_HIER"
    ```

3.  **Speichern und Schließen:**
    Drücke `Ctrl + O`, dann `Enter` (zum Speichern) und `Ctrl + X` (zum Beenden).

-----

## Bot-Bedienung

Alle Befehle müssen in einer WhatsApp-Gruppe gesendet werden, in der der Bot Mitglied ist.

### Die richtige URL finden

Der Bot braucht je nach Befehl eine andere URL:

  * **Für `!start` (Einzelspiel):**

    1.  Geh auf `handball.net` zur **Spiel-Info-Seite** (da, wo auch der Ticker läuft).
    2.  Kopier die URL aus dem Browser, z.B.:
        `https://www.handball.net/spiele/nuliga.bhv.8088464/info`

  * **Für `!autoschedule` (Ganze Saison):**

    1.  Geh auf `handball.net` zur **Mannschafts-Seite**.
    2.  Klick dort auf den Reiter **"Spielplan"**.
    3.  Kopier die URL aus dem Browser, z.B.:
        `https://www.handball.net/mannschaften/nuliga.bhv.1678372/spielplan`

### Befehle

  * **`!start <URL_zum_Spiel> [recap]`**
    Startet den Live-Ticker für ein *einzelnes* Spiel. Der Bot erkennt die Startzeit und legt automatisch los.

      * **Live-Modus (Standard):** `!start <URL>`
      * **Recap-Modus:** `!start <URL> recap` (Sendet alle 5 Min. eine Zusammenfassung).

  * **`!autoschedule <URL_zum_Team-Spielplan> [recap]`**
    Plant automatisch das nächste anstehende Spiel für ein Team. Nach Spielende sucht der Bot automatisch das nächste Spiel und plant es.

      * **Beispiel:** `!autoschedule https://www.handball.net/mannschaften/nuliga.bhv.1678372/spielplan`

  * **`!stop`**
    Stoppt den aktuell laufenden oder geplanten Ticker für diese Gruppe.
    **Wichtig:** Bei einem `!autoschedule` Ticker bricht `!stop` auch die Planung für alle zukünftigen Spiele ab.

  * **`!reset`**
    Stoppt sofort alle Ticker, bricht geplante Aufgaben ab und **löscht alle Spieldaten** (gesehene Events, etc.) für diese Gruppe. Nützlich, falls der Bot sich "verschluckt" hat.

-----

## Bot 24/7 mit PM2 betreiben

Mit PM2 läuft dein Bot dauerhaft und startet automatisch neu, falls er abstürzt.

### 1\. Erster Start & Login

1.  **Bot mit PM2 starten:**
    (Führe das im Projektordner aus)

    ```bash
    pm2 start app.js --name "hnet-ticker"
    ```

2.  **Logs ansehen & QR-Code scannen:**

    ```bash
    pm2 logs hnet-ticker
    ```

    Ein **QR-Code** erscheint im Terminal. Öffne WhatsApp auf deinem Handy, geh zu **Einstellungen \> Gekoppelte Geräte \> Gerät koppeln** und scanne den Code.

    Sobald "WhatsApp-Client ist bereit\!" in den Logs steht, ist der Login fertig. Du kannst die Logs mit `Ctrl + C` verlassen.

### 2\. Autostart nach Neustart einrichten

Damit der Bot auch nach einem Neustart vom Raspberry Pi wieder anläuft.

1.  **Startup-Befehl generieren:**
    ```bash
    pm2 startup
    ```
2.  **Den Befehl ausführen, den PM2 dir anzeigt** (fängt meist mit `sudo env ...` an).
3.  **Prozessliste speichern:**
    ```bash
    pm2 save
    ```

### Nützliche PM2-Befehle

  * `pm2 logs hnet-ticker`: Die Live-Logs ansehen.
  * `pm2 restart hnet-ticker`: Den Bot neustarten (z.B. nachdem du Updates geholt hast).
  * `pm2 stop hnet-ticker`: Den Bot stoppen.
  * `pm2 list`: Den Status all deiner Apps sehen.