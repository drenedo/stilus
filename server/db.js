import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const DATABASE_FILE = "stilus.sqlite";

let database = null;

function nowIso() {
    return new Date().toISOString();
}

function getDatabase() {
    if (!database) {
        throw new Error("La base de datos no se ha inicializado.");
    }
    return database;
}

function mapAccount(row) {
    if (!row) {
        return null;
    }

    return {
        id: row.id,
        username: row.username,
        usernameKey: row.username_key,
        token: row.token,
        obtainedAt: row.obtained_at,
        credentials: row.credentials,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapTelegramSettings(row) {
    if (!row) {
        return null;
    }

    return {
        usernameKey: row.username_key,
        enabled: Boolean(row.enabled),
        chatId: row.chat_id,
        botToken: row.bot_token,
        botTokenHint: row.bot_token_hint,
        initialized: Boolean(row.initialized),
        updatedAt: row.updated_at,
        lastCheckedAt: row.last_checked_at,
        lastSentAt: row.last_sent_at,
        lastError: row.last_error,
    };
}

export function initDatabase(dataDir) {
    if (database) {
        return database;
    }

    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const databasePath = path.join(dataDir, DATABASE_FILE);

    database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");

    database.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            username_key TEXT NOT NULL UNIQUE,
            token TEXT,
            obtained_at TEXT,
            credentials TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS web_sessions (
            id_hash TEXT PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS web_sessions_account_idx
            ON web_sessions(account_id);
        CREATE INDEX IF NOT EXISTS web_sessions_expiry_idx
            ON web_sessions(expires_at);

        CREATE TABLE IF NOT EXISTS read_state (
            username_key TEXT NOT NULL,
            message_uuid TEXT NOT NULL,
            read_at TEXT NOT NULL,
            matricula_ids TEXT NOT NULL,
            PRIMARY KEY (username_key, message_uuid)
        );

        CREATE TABLE IF NOT EXISTS telegram_settings (
            username_key TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            chat_id TEXT,
            bot_token TEXT,
            bot_token_hint TEXT,
            initialized INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT,
            last_checked_at TEXT,
            last_sent_at TEXT,
            last_error TEXT
        );

        CREATE TABLE IF NOT EXISTS telegram_notified (
            username_key TEXT NOT NULL,
            message_uuid TEXT NOT NULL,
            sent_at TEXT NOT NULL,
            PRIMARY KEY (username_key, message_uuid)
        );

        CREATE TABLE IF NOT EXISTS telegram_locks (
            username_key TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
    `);

    try {
        chmodSync(databasePath, 0o600);
    } catch {
        // The directory is private; this is best effort on unusual filesystems.
    }

    return database;
}

export function getDatabasePath(dataDir) {
    return path.join(dataDir, DATABASE_FILE);
}

export function closeDatabase() {
    database?.close();
    database = null;
}

export function getAccountById(accountId) {
    return mapAccount(
        getDatabase()
            .prepare("SELECT * FROM accounts WHERE id = ?")
            .get(accountId),
    );
}

export function getAccountByUsernameKey(usernameKey) {
    return mapAccount(
        getDatabase()
            .prepare("SELECT * FROM accounts WHERE username_key = ?")
            .get(usernameKey),
    );
}

export function upsertAccount({
    username,
    usernameKey,
    token,
    obtainedAt,
    credentials,
}) {
    const timestamp = nowIso();
    const row = getDatabase()
        .prepare(
            `
            INSERT INTO accounts (
                username, username_key, token, obtained_at, credentials,
                created_at, updated_at
            )
            VALUES (
                @username, @usernameKey, @token, @obtainedAt, @credentials,
                @createdAt, @updatedAt
            )
            ON CONFLICT(username_key) DO UPDATE SET
                username = excluded.username,
                token = excluded.token,
                obtained_at = excluded.obtained_at,
                credentials = excluded.credentials,
                updated_at = excluded.updated_at
            RETURNING *
        `,
        )
        .get({
            username,
            usernameKey,
            token,
            obtainedAt,
            credentials,
            createdAt: timestamp,
            updatedAt: timestamp,
        });

    return mapAccount(row);
}

export function updateAccountToken(accountId, token, obtainedAt) {
    return mapAccount(
        getDatabase()
            .prepare(
                `
                UPDATE accounts
                SET token = ?, obtained_at = ?, updated_at = ?
                WHERE id = ?
                RETURNING *
            `,
            )
            .get(token, obtainedAt, nowIso(), accountId),
    );
}

export function invalidateAccount(accountId) {
    const db = getDatabase();
    const transaction = db.transaction(() => {
        db.prepare(
            `
            UPDATE accounts
            SET token = NULL, credentials = NULL, updated_at = ?
            WHERE id = ?
        `,
        ).run(nowIso(), accountId);
        db.prepare("DELETE FROM web_sessions WHERE account_id = ?").run(
            accountId,
        );
    });
    transaction();
}

export function createWebSession({ accountId, idHash, expiresAt }) {
    const timestamp = nowIso();
    getDatabase()
        .prepare(
            `
            INSERT INTO web_sessions (
                id_hash, account_id, created_at, last_seen_at, expires_at
            )
            VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(idHash, accountId, timestamp, timestamp, expiresAt);
}

export function getAccountForWebSession(idHash) {
    const db = getDatabase();
    const timestamp = nowIso();
    db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(timestamp);
    const account = mapAccount(
        db
            .prepare(
                `
            SELECT a.*
            FROM web_sessions AS s
            JOIN accounts AS a ON a.id = s.account_id
            WHERE s.id_hash = ? AND s.expires_at > ?
        `,
            )
            .get(idHash, timestamp),
    );

    if (account) {
        db.prepare(
            "UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?",
        ).run(timestamp, idHash);
    }

    return account;
}

export function deleteWebSession(idHash) {
    getDatabase()
        .prepare("DELETE FROM web_sessions WHERE id_hash = ?")
        .run(idHash);
}

export function getReadMessages(usernameKey) {
    const rows = getDatabase()
        .prepare(
            `
            SELECT message_uuid, read_at, matricula_ids
            FROM read_state
            WHERE username_key = ?
        `,
        )
        .all(usernameKey);

    return Object.fromEntries(
        rows.map((row) => {
            let matriculaIds = [];
            try {
                const parsed = JSON.parse(row.matricula_ids);
                if (Array.isArray(parsed)) {
                    matriculaIds = parsed;
                }
            } catch {
                // Ignore a corrupt row and keep the read timestamp.
            }

            return [
                row.message_uuid,
                { read_at: row.read_at, matricula_ids: matriculaIds },
            ];
        }),
    );
}

export function markMessageRead(usernameKey, messageUuid, matriculaIds) {
    const db = getDatabase();
    const transaction = db.transaction(() => {
        const previous = db
            .prepare(
                `
                SELECT read_at, matricula_ids
                FROM read_state
                WHERE username_key = ? AND message_uuid = ?
            `,
            )
            .get(usernameKey, messageUuid);

        let previousIds = [];
        if (previous) {
            try {
                const parsed = JSON.parse(previous.matricula_ids);
                if (Array.isArray(parsed)) {
                    previousIds = parsed;
                }
            } catch {
                // Ignore a corrupt previous value.
            }
        }

        const ids = [...new Set([...previousIds, ...matriculaIds])];
        const readAt = previous?.read_at ?? nowIso();
        db.prepare(
            `
            INSERT INTO read_state (
                username_key, message_uuid, read_at, matricula_ids
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT(username_key, message_uuid) DO UPDATE SET
                read_at = excluded.read_at,
                matricula_ids = excluded.matricula_ids
        `,
        ).run(usernameKey, messageUuid, readAt, JSON.stringify(ids));

        return { read_at: readAt, matricula_ids: ids };
    });

    return transaction();
}

export function importReadMessages(usernameKey, messages) {
    const db = getDatabase();
    const transaction = db.transaction(() => {
        const insert = db.prepare(
            `
            INSERT OR IGNORE INTO read_state (
                username_key, message_uuid, read_at, matricula_ids
            )
            VALUES (?, ?, ?, ?)
        `,
        );

        for (const [messageUuid, message] of Object.entries(messages ?? {})) {
            if (!messageUuid || !message || typeof message !== "object") {
                continue;
            }
            insert.run(
                usernameKey,
                messageUuid,
                typeof message.read_at === "string"
                    ? message.read_at
                    : nowIso(),
                JSON.stringify(
                    Array.isArray(message.matricula_ids)
                        ? message.matricula_ids
                        : [],
                ),
            );
        }
    });
    transaction();
}

export function getTelegramSettings(usernameKey) {
    return mapTelegramSettings(
        getDatabase()
            .prepare("SELECT * FROM telegram_settings WHERE username_key = ?")
            .get(usernameKey),
    );
}

export function upsertTelegramSettings({
    usernameKey,
    enabled,
    chatId,
    botToken,
    botTokenHint,
    initialized,
}) {
    const db = getDatabase();
    const row = db
        .prepare(
            `
            INSERT INTO telegram_settings (
                username_key, enabled, chat_id, bot_token, bot_token_hint,
                initialized, updated_at
            )
            VALUES (
                @usernameKey, @enabled, @chatId, @botToken, @botTokenHint,
                @initialized, @updatedAt
            )
            ON CONFLICT(username_key) DO UPDATE SET
                enabled = excluded.enabled,
                chat_id = excluded.chat_id,
                bot_token = excluded.bot_token,
                bot_token_hint = excluded.bot_token_hint,
                initialized = excluded.initialized,
                updated_at = excluded.updated_at
            RETURNING *
        `,
        )
        .get({
            usernameKey,
            enabled: enabled ? 1 : 0,
            chatId: chatId || null,
            botToken: botToken || null,
            botTokenHint: botTokenHint || null,
            initialized: initialized ? 1 : 0,
            updatedAt: nowIso(),
        });

    return mapTelegramSettings(row);
}

export function updateTelegramStatus(
    usernameKey,
    { checkedAt, sentAt, error, initialized } = {},
) {
    const db = getDatabase();
    const current = db
        .prepare("SELECT * FROM telegram_settings WHERE username_key = ?")
        .get(usernameKey);

    if (!current) {
        return null;
    }

    db.prepare(
        `
        UPDATE telegram_settings
        SET initialized = ?,
            last_checked_at = ?,
            last_sent_at = ?,
            last_error = ?
        WHERE username_key = ?
    `,
    ).run(
        initialized === undefined ? current.initialized : initialized ? 1 : 0,
        checkedAt === undefined ? current.last_checked_at : checkedAt,
        sentAt === undefined ? current.last_sent_at : sentAt,
        error === undefined ? current.last_error : error,
        usernameKey,
    );

    return getTelegramSettings(usernameKey);
}

export function deleteTelegramSettings(usernameKey) {
    const db = getDatabase();
    const transaction = db.transaction(() => {
        db.prepare("DELETE FROM telegram_settings WHERE username_key = ?").run(
            usernameKey,
        );
        db.prepare("DELETE FROM telegram_notified WHERE username_key = ?").run(
            usernameKey,
        );
        db.prepare("DELETE FROM telegram_locks WHERE username_key = ?").run(
            usernameKey,
        );
    });
    transaction();
}

export function getTelegramNotified(usernameKey) {
    const rows = getDatabase()
        .prepare(
            `
            SELECT message_uuid, sent_at
            FROM telegram_notified
            WHERE username_key = ?
        `,
        )
        .all(usernameKey);

    return Object.fromEntries(
        rows.map((row) => [row.message_uuid, row.sent_at]),
    );
}

export function markTelegramNotified(usernameKey, messageUuid, sentAt) {
    getDatabase()
        .prepare(
            `
            INSERT INTO telegram_notified (username_key, message_uuid, sent_at)
            VALUES (?, ?, ?)
            ON CONFLICT(username_key, message_uuid) DO UPDATE SET
                sent_at = excluded.sent_at
        `,
        )
        .run(usernameKey, messageUuid, sentAt);
}

export function baselineTelegramNotified(usernameKey, messageUuids, checkedAt) {
    const db = getDatabase();
    const transaction = db.transaction(() => {
        db.prepare("DELETE FROM telegram_notified WHERE username_key = ?").run(
            usernameKey,
        );
        const insert = db.prepare(
            `
            INSERT OR REPLACE INTO telegram_notified (
                username_key, message_uuid, sent_at
            )
            VALUES (?, ?, ?)
        `,
        );

        for (const messageUuid of messageUuids) {
            insert.run(usernameKey, messageUuid, checkedAt);
        }
    });
    transaction();
}

export function importTelegramSettings(usernameKey, config) {
    if (!config || typeof config !== "object") {
        return;
    }

    const db = getDatabase();
    const transaction = db.transaction(() => {
        db.prepare(
            `
            INSERT INTO telegram_settings (
                username_key, enabled, chat_id, bot_token, bot_token_hint,
                initialized, updated_at, last_checked_at, last_sent_at,
                last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username_key) DO UPDATE SET
                enabled = excluded.enabled,
                chat_id = excluded.chat_id,
                bot_token = excluded.bot_token,
                bot_token_hint = excluded.bot_token_hint,
                initialized = excluded.initialized,
                last_checked_at = excluded.last_checked_at,
                last_sent_at = excluded.last_sent_at,
                last_error = excluded.last_error
        `,
        ).run(
            usernameKey,
            config.enabled ? 1 : 0,
            config.chat_id || null,
            config.bot_token ? JSON.stringify(config.bot_token) : null,
            config.bot_token_hint || null,
            config.initialized ? 1 : 0,
            config.updated_at || nowIso(),
            config.last_checked_at || null,
            config.last_sent_at || null,
            config.last_error || null,
        );

        db.prepare("DELETE FROM telegram_notified WHERE username_key = ?").run(
            usernameKey,
        );
        const insert = db.prepare(
            `
            INSERT OR REPLACE INTO telegram_notified (
                username_key, message_uuid, sent_at
            )
            VALUES (?, ?, ?)
        `,
        );
        for (const [messageUuid, sentAt] of Object.entries(
            config.notified ?? {},
        )) {
            if (messageUuid) {
                insert.run(usernameKey, messageUuid, sentAt || nowIso());
            }
        }
    });
    transaction();
}

export function listTelegramTargets(usernameKey = null) {
    const rows = getDatabase()
        .prepare(
            `
            SELECT
                a.id, a.username, a.username_key, a.token, a.obtained_at,
                a.credentials, a.created_at, a.updated_at,
                s.enabled AS telegram_enabled,
                s.chat_id AS telegram_chat_id,
                s.bot_token AS telegram_bot_token,
                s.bot_token_hint AS telegram_bot_token_hint,
                s.initialized AS telegram_initialized,
                s.updated_at AS telegram_updated_at,
                s.last_checked_at AS telegram_last_checked_at,
                s.last_sent_at AS telegram_last_sent_at,
                s.last_error AS telegram_last_error
            FROM telegram_settings AS s
            JOIN accounts AS a ON a.username_key = s.username_key
            WHERE s.enabled = 1
              AND s.chat_id IS NOT NULL
              AND s.chat_id <> ''
              AND a.token IS NOT NULL
              AND a.credentials IS NOT NULL
              AND (? IS NULL OR s.username_key = ?)
            ORDER BY a.id
        `,
        )
        .all(usernameKey, usernameKey);

    return rows.map((row) => ({
        account: mapAccount(row),
        settings: {
            usernameKey: row.username_key,
            enabled: Boolean(row.telegram_enabled),
            chatId: row.telegram_chat_id,
            botToken: row.telegram_bot_token,
            botTokenHint: row.telegram_bot_token_hint,
            initialized: Boolean(row.telegram_initialized),
            updatedAt: row.telegram_updated_at,
            lastCheckedAt: row.telegram_last_checked_at,
            lastSentAt: row.telegram_last_sent_at,
            lastError: row.telegram_last_error,
        },
    }));
}

export function claimTelegramLock(usernameKey, owner, ttlMs = 15 * 60_000) {
    const db = getDatabase();
    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const transaction = db.transaction(() => {
        db.prepare("DELETE FROM telegram_locks WHERE expires_at <= ?").run(
            timestamp,
        );
        const result = db
            .prepare(
                `
                INSERT OR IGNORE INTO telegram_locks (
                    username_key, owner, expires_at
                )
                VALUES (?, ?, ?)
            `,
            )
            .run(usernameKey, owner, expiresAt);
        return result.changes === 1;
    });

    return transaction();
}

export function releaseTelegramLock(usernameKey, owner) {
    getDatabase()
        .prepare(
            `
            DELETE FROM telegram_locks
            WHERE username_key = ? AND owner = ?
        `,
        )
        .run(usernameKey, owner);
}

export function deleteAccountData(usernameKey) {
    const db = getDatabase();
    const account = getAccountByUsernameKey(usernameKey);
    const transaction = db.transaction(() => {
        db.prepare("DELETE FROM read_state WHERE username_key = ?").run(
            usernameKey,
        );
        db.prepare("DELETE FROM telegram_notified WHERE username_key = ?").run(
            usernameKey,
        );
        db.prepare("DELETE FROM telegram_settings WHERE username_key = ?").run(
            usernameKey,
        );
        db.prepare("DELETE FROM telegram_locks WHERE username_key = ?").run(
            usernameKey,
        );
        if (account) {
            db.prepare("DELETE FROM web_sessions WHERE account_id = ?").run(
                account.id,
            );
            db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
        }
    });
    transaction();
}
