import { spawn } from "node:child_process";
import {
    closeSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const PID_PATH = path.join(SCRIPT_DIR, "telegram-cli.pid");
const LOG_PATH = path.join(SCRIPT_DIR, "telegram-cli.log");

const HELP = `Stilus · headless Telegram mode

Usage:
  npm run telegram -- --bot-token <token> --user <username> --password <password> [options]

Options:
  --bot-token <token>   Telegram bot token (or TELEGRAM_BOT_TOKEN).
  --chat-id <id>        Destination chat. If omitted, it is detected with getUpdates.
  --user, --username    Educa username (or STILUS_USER).
  --password <secret>   Educa password (or STILUS_PASSWORD).
  --interval <minutes>  Check interval in minutes. Default: 5.
  --detach              Run in the background.
  --stop                Stop the background process.
  --help                Show this help.

Examples:
  npm run telegram -- --bot-token "123:ABC" --user "name@educa.jcyl.es" --password "secret"
  npm run telegram -- --bot-token "123:ABC" --user "name@educa.jcyl.es" --password "secret" --detach
  npm run telegram -- --stop

Equivalent environment variables:
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, STILUS_USER, STILUS_PASSWORD

Notes:
  - The first run marks the current messages as already notified.
  - New messages and their attachments are sent to the configured chat.
  - In --detach mode, the log is written to server/telegram-cli.log.
  - Avoid passing secrets as command-line arguments on shared machines; use
    environment variables or your shell's secure input instead.
`;

let values;
try {
    ({ values } = parseArgs({
        options: {
            "bot-token": { type: "string" },
            "chat-id": { type: "string" },
            user: { type: "string" },
            username: { type: "string" },
            password: { type: "string" },
            interval: { type: "string" },
            detach: { type: "boolean" },
            stop: { type: "boolean" },
            help: { type: "boolean" },
        },
        strict: true,
        allowPositionals: false,
    }));
} catch (error) {
    console.error(error.message);
    console.error(HELP);
    process.exit(1);
}

if (values.help) {
    console.log(HELP);
    process.exit(0);
}

if (values.stop) {
    try {
        const pid = Number(readFileSync(PID_PATH, "utf8").trim());
        if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error("Invalid PID.");
        }
        process.kill(pid, "SIGTERM");
        console.log(`Process ${pid} stopped.`);
    } catch (error) {
        console.error(`Could not stop the process: ${error.message}`);
        process.exitCode = 1;
    } finally {
        try {
            unlinkSync(PID_PATH);
        } catch {
            // The PID file may already be gone.
        }
    }
    process.exit();
}

const botToken = values["bot-token"] ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
const username =
    values.user ?? values.username ?? process.env.STILUS_USER ?? "";
const password = values.password ?? process.env.STILUS_PASSWORD ?? "";
const chatIdInput = values["chat-id"] ?? process.env.TELEGRAM_CHAT_ID ?? "";
const intervalMinutes = Number(values.interval ?? 5);

if (!botToken.trim()) {
    console.error("Missing bot token: use --bot-token or TELEGRAM_BOT_TOKEN.");
    process.exit(1);
}
if (!username.trim()) {
    console.error("Missing username: use --user or STILUS_USER.");
    process.exit(1);
}
if (!password) {
    console.error("Missing password: use --password or STILUS_PASSWORD.");
    process.exit(1);
}
if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    console.error("The interval must be a positive number of minutes.");
    process.exit(1);
}

if (values.detach && process.env.STILUS_TELEGRAM_DAEMON !== "1") {
    const childArgs = process.argv
        .slice(2)
        .filter((argument) => argument !== "--detach");
    let logDescriptor;

    try {
        logDescriptor = openSync(LOG_PATH, "a", 0o600);
    } catch (error) {
        console.error(
            `Could not open the log file ${LOG_PATH}: ${error.message}`,
        );
        process.exit(1);
    }

    const child = spawn(process.execPath, [SCRIPT_PATH, ...childArgs], {
        cwd: ROOT_DIR,
        detached: true,
        stdio: ["ignore", logDescriptor, logDescriptor],
        env: {
            ...process.env,
            STILUS_TELEGRAM_DAEMON: "1",
        },
    });
    closeSync(logDescriptor);

    if (!child.pid) {
        console.error("Could not start the background process.");
        process.exit(1);
    }

    writeFileSync(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
    child.unref();

    console.log(`Running in the background. PID: ${child.pid}`);
    console.log(`Log: ${LOG_PATH}`);
    console.log("To stop it: npm run telegram -- --stop");
    process.exit(0);
}

const {
    baselineTelegram,
    discoverTelegramChats,
    loginAndPersist,
    pollTelegramNotifications,
    releaseTelegramLock,
    saveTelegramConfig,
} = await import("./index.js");

function timestamp() {
    return new Date().toISOString();
}

let timer = null;
let stopping = false;

function cleanup() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    releaseTelegramLock();

    if (process.env.STILUS_TELEGRAM_DAEMON === "1") {
        try {
            const current = Number(readFileSync(PID_PATH, "utf8").trim());
            if (current === process.pid) {
                unlinkSync(PID_PATH);
            }
        } catch {
            // The PID file may already be gone.
        }
    }
}

function stop(signal) {
    if (stopping) {
        return;
    }
    stopping = true;
    console.log(`\n[${timestamp()}] ${signal}: stopping Telegram mode…`);
    cleanup();
    process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

try {
    console.log(`[${timestamp()}] Signing in to Stilus as ${username}…`);
    const session = await loginAndPersist(username.trim(), password);
    console.log(
        `[${timestamp()}] Signed in. Token valid until ${session.expires_at}.`,
    );

    let chatId = chatIdInput.trim();
    if (!chatId) {
        console.log(`[${timestamp()}] Detecting Telegram chat…`);
        const chats = await discoverTelegramChats(botToken.trim());
        if (!chats.length) {
            throw new Error(
                "No chat detected. Open the bot in Telegram, send /start, or pass --chat-id.",
            );
        }
        chatId = chats[0].id;
        console.log(
            `[${timestamp()}] Chat detected: ${chats[0].name} (${chatId}).`,
        );
    }

    const config = await saveTelegramConfig(username.trim(), {
        botToken: botToken.trim(),
        chatId,
        enabled: true,
    });

    if (!config.initialized) {
        console.log(
            `[${timestamp()}] Marking current messages as already notified…`,
        );
        await baselineTelegram(username.trim());
    }

    console.log(
        `[${timestamp()}] Telegram notifications active for chat ${config.chat_id}.`,
    );
    console.log(
        `Checking for new messages every ${intervalMinutes} minute(s). Press Ctrl+C to stop.`,
    );

    console.log(`[${timestamp()}] Checking for new messages…`);
    await pollTelegramNotifications();

    const intervalMs = Math.max(1000, intervalMinutes * 60_000);
    timer = setInterval(() => {
        console.log(`[${timestamp()}] Checking for new messages…`);
        void pollTelegramNotifications();
    }, intervalMs);
} catch (error) {
    console.error(`[${timestamp()}] Error: ${error.message}`);
    cleanup();
    process.exit(1);
}
