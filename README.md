# WhatsApp Live Ticker Bot (handball.net)

This is a high-performance WhatsApp bot that provides real-time game updates from `handball.net` directly into your WhatsApp groups. It's perfect for keeping your team, friends, or family updated when they can't watch the game\!

This project is a complete migration from an older, `nuliga`-based bot. It replaces the slow, resource-heavy Puppeteer scraping with direct, high-speed JSON polling of the `handball.net` data API. This makes the bot significantly faster, lighter, and more reliable.

## ✨ Features

  * **Dual Ticker Modes:**
      * **Live Mode:** Sends a message for *every single event* as it happens.
      * **Recap Mode:** Sends a 5-minute summary of all events (perfect for less "spammy" updates).
  * **🤖 AI-Powered Summaries:** At the end of the game, a sarcastic AI commentator (powered by Google's Gemini) provides a witty, personalized summary of the match.
  * **📊 Detailed Stats:** Posts a full breakdown of the final game stats, including top scorers, 7-meter stats, and all card penalties.
  * **Smart Scheduling:** You can start the bot hours in advance. It automatically reads the game's official start time and begins polling a few minutes before the first whistle.
  * **Persistent & Recoverable:** The bot saves all scheduled tickers and seen events. If you restart the bot, it will pick up right where it left off.

-----

## ⚙️ Setup Instructions

This bot is designed to run 24/7 on a server like a Raspberry Pi.

### Prerequisites

  * A server (Raspberry Pi 4 recommended) with Raspberry Pi OS or another Linux distro.
  * [Node.js](https://nodejs.org/) (version 16 or newer).
  * [Git](https://git-scm.com/) installed.
  * [Chromium](https://www.chromium.org/): `whatsapp-web.js` requires a browser to run.
  * A **dedicated WhatsApp account** (it's highly recommended to use a separate number).
  * A **Google Gemini API Key** for the AI summaries.

### 1\. Installation

1.  **Clone the Repository**

    ```bash
    # Run from your home directory (or wherever you want to store the project)
    git clone [URL_TO_YOUR_GIT_REPO] handball-net-bot
    cd handball-net-bot
    ```

2.  **Install Dependencies**
    This installs all necessary Node.js packages.

    ```bash
    npm install
    ```

3.  **Install System Packages**
    Install `pm2` (our process manager) and `chromium` (for WhatsApp Web).

    ```bash
    # Install PM2 globally
    sudo npm install pm2 -g

    # Install Chromium browser
    sudo apt update
    sudo apt install -y chromium
    ```

### 2\. Configuration

You must create a `.env` file to store your API key.

1.  **Create the `.env` file:**

    ```bash
    nano .env
    ```

2.  **Add your key:**
    Paste the following line into the editor, replacing the placeholder with your key:

    ```
    GEMINI_API_KEY="YOUR_API_KEY_HERE"
    ```

3.  **Save and Exit:**
    Press `Ctrl + O`, `Enter` to save, and `Ctrl + X` to exit.

-----

## 🤖 How to Use the Bot

All commands must be sent in a WhatsApp group where the bot has been added.

**Note:** The commands are prefixed with `!hnet-` to run in parallel with the old `nuliga` bot.

### Finding the Ticker URL

1.  Navigate to the game page on `handball.net`.
2.  Copy the URL directly from your browser's address bar.
3.  The bot is smart and can handle most formats, such as:
      * `https://www.handball.net/spiele/nuliga.hvberlin.8062487/ticker`
      * `https://www.handball.net/spiele/handball4all.baden-wuerttemberg.8549261/info`
      * `https://www.handball.net/spiele/sportradar.dhbdata.86767`

### Commands

  * **`!hnet-start <URL> [recap]`**
    Schedules the live ticker for a game. The bot will figure out the start time and activate itself automatically.

      * **Live Mode (Default):** Use `!hnet-start <URL>`
      * **Recap Mode:** Use `!hnet-start <URL> recap` to get summaries every 5 minutes.

  * **`!hnet-stop`**
    Stops the currently running or scheduled ticker for that group.

  * **`!hnet-reset`**
    Immediately stops the ticker, cancels any scheduled tasks, and **deletes all game data** for the group. This is useful for debugging or before starting a new ticker in the same group.

-----

## 🚀 Running the Bot with PM2

Using PM2 will keep your bot running 24/7 and automatically restart it if it crashes.

### 1\. First Time Start & Login

1.  **Start the bot with PM2:**
    (Run this from inside your project folder)

    ```bash
    pm2 start app.js --name "hnet-ticker"
    ```

2.  **View the Logs & Scan QR Code:**

    ```bash
    pm2 logs hnet-ticker
    ```

    A **QR code** will appear in the terminal. Open WhatsApp on your phone, go to **Settings \> Linked Devices \> Link a Device**, and scan the code.

    Once you see "WhatsApp-Client ist bereit\!", the login is complete\! You can exit the logs by pressing `Ctrl + C`.

### 2\. Enable Auto-Start on Reboot

This makes sure your bot starts automatically if the Raspberry Pi restarts.

1.  **Generate the startup command:**
    ```bash
    pm2 startup
    ```
2.  **Run the command it gives you** (it usually starts with `sudo env ...`).
3.  **Save the process list:**
    ```bash
    pm2 save
    ```

### Useful PM2 Commands

  * `pm2 logs hnet-ticker`: View the live logs.
  * `pm2 restart hnet-ticker`: Restart the bot (use this after pulling updates).
  * `pm2 stop hnet-ticker`: Stop the bot.
  * `pm2 list`: See the status of all your apps.