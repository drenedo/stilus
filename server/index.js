import { spawn, spawnSync } from "node:child_process";
import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from "node:crypto";
import {
    access,
    chmod,
    mkdir,
    readFile,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cookieParser from "cookie-parser";
import express from "express";

import {
    baselineTelegramNotified,
    claimTelegramLock,
    createWebSession,
    deleteAccountData,
    deleteTelegramSettings,
    deleteWebSession,
    getAccountById,
    getAccountByUsernameKey,
    getAccountForWebSession,
    getDatabasePath,
    getReadMessages,
    getTelegramNotified,
    getTelegramSettings,
    importReadMessages,
    importTelegramSettings,
    initDatabase,
    invalidateAccount,
    listTelegramTargets,
    markMessageRead,
    markTelegramNotified,
    releaseTelegramLock,
    updateAccountToken,
    updateTelegramStatus,
    upsertAccount,
    upsertTelegramSettings,
} from "./db.js";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SERVER_DIR, "..");
const DATA_DIR = path.resolve(process.env.STILUS_DATA_DIR || ROOT_DIR);
const SCRIPT_PATH = path.join(ROOT_DIR, "get_token.py");
const KEY_PATH = path.join(DATA_DIR, ".session.key");
const DATABASE_FILE_NAME = path.basename(getDatabasePath(DATA_DIR));
const CONFIG_PATH =
    process.env.STILUS_CONFIG || path.join(ROOT_DIR, "config.yaml");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend", "dist");
const FRONTEND_INDEX = path.join(FRONTEND_DIR, "index.html");
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || "127.0.0.1";
const LOGIN_TIMEOUT_MS = 120_000;
const WEB_SESSION_COOKIE = "stilus_session";
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE =
    String(process.env.COOKIE_SECURE ?? "").toLowerCase() === "true";
const TELEGRAM_API_BASE =
    process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const TELEGRAM_POLL_INTERVAL_MS = 5 * 60 * 1000;
const TELEGRAM_LOCK_TTL_MS = 60 * 60 * 1000;
const PORTAL_BASE_URL = "https://stilus.educa.jcyl.es/bkstfm";
const PORTAL_TIMEOUT_MS = 30_000;
const COMMUNICATIONS_PAGE_SIZE = 80;
const COMMUNICATIONS_MAX_PAGES = 20;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ORIGINS = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]);

// Keep the database, WAL/SHM files and the encryption key private on new files.
process.umask(0o077);

try {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    if (DATA_DIR !== ROOT_DIR) {
        await chmod(DATA_DIR, 0o700).catch(() => {});
    }
    initDatabase(DATA_DIR);
} catch (error) {
    console.error(
        `Could not initialize data directory ${DATA_DIR}: ${error.message}`,
    );
    console.error(
        "Check that the container user (PUID/PGID in Compose) owns and can write this directory.",
    );
    process.exit(1);
}

class ApiError extends Error {
    constructor(status, message, options = {}) {
        super(message);
        this.status = status;
        this.source = options.source ?? null;
        this.upstreamStatus = options.upstreamStatus ?? null;
    }
}

function pathExists(target) {
    return access(target).then(
        () => true,
        () => false,
    );
}

function pythonHasDependencies(command) {
    const result = spawnSync(command, ["-c", "import yaml, selenium"], {
        stdio: "ignore",
    });
    return result.status === 0;
}

function resolvePython() {
    const candidates = [];

    if (process.env.PYTHON) {
        candidates.push(process.env.PYTHON);
    }

    for (const directory of ["venv", ".venv", "env"]) {
        candidates.push(
            process.platform === "win32"
                ? path.join(ROOT_DIR, directory, "Scripts", "python.exe")
                : path.join(ROOT_DIR, directory, "bin", "python"),
        );
    }

    candidates.push(
        process.platform === "win32" ? "python" : "python3",
        "python",
    );

    for (const candidate of new Set(candidates)) {
        if (pythonHasDependencies(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        [
            "No se encontró un intérprete de Python con PyYAML y Selenium.",
            "Crea el entorno virtual e instala las dependencias:",
            "",
            "  python3 -m venv venv",
            "  ./venv/bin/pip install -r requirements.txt",
            "",
            "También puedes indicar el intérprete con PYTHON=/ruta/al/python.",
        ].join("\n"),
    );
}

function classifyFailure(stderr, stdout) {
    const output = `${stderr}\n${stdout}`;

    if (/AuthenticationError/.test(output)) {
        return new ApiError(
            401,
            "El usuario o la contraseña no son correctos. Revisa los datos e inténtalo de nuevo.",
        );
    }

    if (/ModuleNotFoundError|No module named '(yaml|selenium)'/i.test(output)) {
        return new ApiError(
            500,
            "El intérprete de Python no tiene las dependencias instaladas. Ejecuta: python3 -m venv venv && ./venv/bin/pip install -r requirements.txt",
        );
    }

    if (/No access_token|IndexError|list index out of range/i.test(output)) {
        return new ApiError(
            502,
            "El portal no devolvió un token de sesión. Inténtalo de nuevo más tarde.",
        );
    }

    if (
        /Geckodriver not found|Missing geckodriver|Missing credentials/i.test(
            output,
        )
    ) {
        return new ApiError(
            500,
            "La configuración de Selenium está incompleta.",
        );
    }

    if (/WebDriverException|geckodriver|Firefox/i.test(output)) {
        return new ApiError(
            502,
            "No se pudo abrir el navegador para iniciar sesión. Comprueba Firefox y geckodriver.",
        );
    }

    if (/TimeoutException|Timeout waiting|timed out/i.test(output)) {
        return new ApiError(
            504,
            "El portal tardó demasiado en responder. Se volverá a intentar automáticamente.",
        );
    }

    return new ApiError(500, "Error inesperado al obtener el token.");
}

function getTokenFromPython(python, username, password) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        let timeout;

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            callback(value);
        };

        const child = spawn(
            python,
            [SCRIPT_PATH, "--config", CONFIG_PATH, "--credentials-stdin"],
            {
                cwd: ROOT_DIR,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );

        timeout = setTimeout(() => {
            child.kill("SIGKILL");
            finish(
                reject,
                new ApiError(
                    504,
                    "La autenticación tardó demasiado. Inténtalo de nuevo más tarde.",
                ),
            );
        }, LOGIN_TIMEOUT_MS);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");

        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });

        child.on("error", (error) => {
            finish(
                reject,
                new ApiError(
                    500,
                    `No se pudo ejecutar Python: ${error.message}`,
                ),
            );
        });

        child.on("close", (code) => {
            const lines = stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            const token = lines.at(-1);

            if (code === 0 && token) {
                finish(resolve, token);
                return;
            }

            if (stderr.trim()) {
                console.error(`[get_token.py]\n${stderr.trim()}`);
            }
            finish(reject, classifyFailure(stderr, stdout));
        });

        // The child may exit before reading stdin; avoid an unhandled EPIPE.
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify({ name: username, password }));
    });
}

let encryptionKeyPromise = null;

async function loadOrCreateKey() {
    try {
        const stored = (await readFile(KEY_PATH, "utf8")).trim();
        const key = Buffer.from(stored, "hex");
        if (key.length !== 32) {
            throw new Error(
                `${path.basename(KEY_PATH)} no contiene una clave válida.`,
            );
        }
        await chmod(KEY_PATH, 0o600).catch(() => {});
        return key;
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }

    const key = randomBytes(32);
    try {
        await writeFile(KEY_PATH, `${key.toString("hex")}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        });
        await chmod(KEY_PATH, 0o600).catch(() => {});
        return key;
    } catch (error) {
        if (error.code === "EEXIST") {
            return loadOrCreateKey();
        }
        throw error;
    }
}

function getEncryptionKey() {
    if (!encryptionKeyPromise) {
        encryptionKeyPromise = loadOrCreateKey().catch((error) => {
            encryptionKeyPromise = null;
            throw error;
        });
    }
    return encryptionKeyPromise;
}

async function encryptJson(value) {
    const key = await getEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
        cipher.update(JSON.stringify(value), "utf8"),
        cipher.final(),
    ]);

    return {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
    };
}

async function decryptJson(payload) {
    if (
        !payload ||
        typeof payload.iv !== "string" ||
        typeof payload.tag !== "string" ||
        typeof payload.data !== "string"
    ) {
        throw new Error("Formato de credenciales cifradas no válido.");
    }

    const key = await getEncryptionKey();
    const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.data, "base64")),
        decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plaintext);
}

function usernameKeyFor(username) {
    return username.trim().toLocaleLowerCase("es");
}

function decodeJwtPayload(token) {
    const parts = token.split(".");
    if (parts.length !== 3) {
        return null;
    }

    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        return null;
    }
}

function getTokenExpiry(token) {
    const payload = decodeJwtPayload(token);
    if (payload && Number.isFinite(payload.exp)) {
        return payload.exp * 1000;
    }
    return null;
}

function isTokenExpired(token) {
    const expiry = getTokenExpiry(token);
    return expiry !== null && expiry <= Date.now();
}

function parseStoredPayload(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

async function decryptAccountCredentials(account) {
    const payload = parseStoredPayload(account?.credentials);
    if (!payload) {
        throw new ApiError(
            401,
            "No hay credenciales guardadas para esta cuenta. Inicia sesión de nuevo.",
        );
    }

    let credentials;
    try {
        credentials = await decryptJson(payload);
    } catch (error) {
        console.error(
            `No se pudieron descifrar las credenciales de ${account.username}: ${error.message}`,
        );
        invalidateAccount(account.id);
        throw new ApiError(
            401,
            "Las credenciales guardadas no son válidas. Inicia sesión de nuevo.",
        );
    }

    if (
        typeof credentials?.username !== "string" ||
        typeof credentials?.password !== "string"
    ) {
        invalidateAccount(account.id);
        throw new ApiError(
            401,
            "Las credenciales guardadas no son válidas. Inicia sesión de nuevo.",
        );
    }

    return credentials;
}

async function decryptAccountToken(account) {
    const payload = parseStoredPayload(account?.token);
    if (!payload) {
        throw new ApiError(
            401,
            "No hay una sesión guardada. Inicia sesión para continuar.",
        );
    }

    let decrypted;
    try {
        decrypted = await decryptJson(payload);
    } catch (error) {
        console.error(
            `No se pudo descifrar el token de ${account.username}: ${error.message}`,
        );
        invalidateAccount(account.id);
        throw new ApiError(
            401,
            "La sesión guardada no es válida. Vuelve a iniciar sesión.",
        );
    }

    if (typeof decrypted?.token !== "string" || !decrypted.token) {
        invalidateAccount(account.id);
        throw new ApiError(
            401,
            "La sesión guardada no es válida. Vuelve a iniciar sesión.",
        );
    }

    return decrypted.token;
}

function sessionPayload(account, token, renewed = false) {
    return {
        status: "ok",
        username: account.username,
        token,
        obtained_at: account.obtainedAt,
        renewed,
    };
}

// Selenium opens a browser per login, so authentications are serialized in this
// process. The optional CLI is a separate process; avoid refreshing the same
// account from both at once.
let authQueue = Promise.resolve();
function enqueueAuthentication(task) {
    const result = authQueue.then(task, task);
    authQueue = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

async function loginAndPersist(username, password) {
    const token = await getTokenFromPython(python, username, password);
    const account = upsertAccount({
        username,
        usernameKey: usernameKeyFor(username),
        token: JSON.stringify(await encryptJson({ token })),
        obtainedAt: new Date().toISOString(),
        credentials: JSON.stringify(await encryptJson({ username, password })),
    });

    return { account, token };
}

const refreshPromises = new Map();

function refreshAccount(account) {
    const key = String(account.id);
    if (refreshPromises.has(key)) {
        return refreshPromises.get(key);
    }

    const operation = (async () => {
        const current = getAccountById(account.id);
        if (!current?.token || !current?.credentials) {
            throw new ApiError(
                401,
                "La sesión guardada no es válida. Inicia sesión de nuevo.",
            );
        }

        const credentials = await decryptAccountCredentials(current);

        let token;
        try {
            token = await enqueueAuthentication(() =>
                getTokenFromPython(
                    python,
                    credentials.username,
                    credentials.password,
                ),
            );
        } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
                invalidateAccount(current.id);
            }
            throw error;
        }

        const renewed = updateAccountToken(
            current.id,
            JSON.stringify(await encryptJson({ token })),
            new Date().toISOString(),
        );

        console.log(`Token renewed for ${current.username}.`);
        return { account: renewed, token, renewed: true };
    })().finally(() => {
        refreshPromises.delete(key);
    });

    refreshPromises.set(key, operation);
    return operation;
}

async function ensureAccountToken(account) {
    const current = getAccountById(account.id);
    if (!current?.token || !current?.credentials) {
        throw new ApiError(
            401,
            "La sesión guardada no es válida. Inicia sesión de nuevo.",
        );
    }

    const token = await decryptAccountToken(current);
    if (isTokenExpired(token)) {
        return refreshAccount(current);
    }

    return { account: current, token, renewed: false };
}

function hashSessionId(value) {
    return createHash("sha256").update(value).digest("hex");
}

function cookieOptions(maxAge) {
    return {
        httpOnly: true,
        sameSite: "lax",
        secure: COOKIE_SECURE,
        path: "/",
        ...(maxAge ? { maxAge } : {}),
    };
}

function startWebSession(response, accountId) {
    const rawSessionId = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + WEB_SESSION_TTL_MS).toISOString();

    createWebSession({
        accountId,
        idHash: hashSessionId(rawSessionId),
        expiresAt,
    });
    response.cookie(
        WEB_SESSION_COOKIE,
        rawSessionId,
        cookieOptions(WEB_SESSION_TTL_MS),
    );

    return rawSessionId;
}

function endWebSession(request, response) {
    const rawSessionId = request.cookies?.[WEB_SESSION_COOKIE];
    if (rawSessionId) {
        deleteWebSession(hashSessionId(rawSessionId));
    }
    response.clearCookie(WEB_SESSION_COOKIE, cookieOptions());
}

function requireWebSession(request) {
    const rawSessionId = request.cookies?.[WEB_SESSION_COOKIE];
    if (!rawSessionId) {
        throw new ApiError(
            401,
            "No hay una sesión guardada. Inicia sesión para continuar.",
        );
    }

    const sessionHash = hashSessionId(rawSessionId);
    const account = getAccountForWebSession(sessionHash);
    if (!account) {
        throw new ApiError(
            401,
            "La sesión del navegador ha caducado. Inicia sesión de nuevo.",
        );
    }

    return { account, sessionHash };
}

function getUserReadMessages(usernameKey) {
    return getReadMessages(usernameKey);
}

function markMessageLocallyRead(usernameKey, uuid, matriculaIds) {
    return markMessageRead(usernameKey, uuid, matriculaIds);
}

async function removeLegacyFile(filePath) {
    try {
        await unlink(filePath);
    } catch (error) {
        if (error.code !== "ENOENT") {
            console.error(
                `No se pudo eliminar ${path.basename(filePath)}: ${error.message}`,
            );
        }
    }
}

async function migrateLegacyState() {
    const legacySessionPath = path.join(DATA_DIR, "session.json");
    const legacyReadStatePath = path.join(DATA_DIR, "read-state.json");
    const legacyTelegramPath = path.join(DATA_DIR, "telegram.json");
    const legacyTelegramLockPath = path.join(DATA_DIR, "telegram.lock");
    let migratedSomething = false;

    if (await pathExists(legacySessionPath)) {
        let legacySession;
        try {
            legacySession = JSON.parse(
                await readFile(legacySessionPath, "utf8"),
            );
        } catch (error) {
            console.error(
                `No se pudo leer session.json para migrarlo: ${error.message}`,
            );
        }

        if (
            typeof legacySession?.username === "string" &&
            typeof legacySession?.token === "string" &&
            legacySession.token &&
            legacySession.credentials
        ) {
            const legacyUsernameKey = usernameKeyFor(legacySession.username);
            if (!getAccountByUsernameKey(legacyUsernameKey)) {
                try {
                    upsertAccount({
                        username: legacySession.username,
                        usernameKey: legacyUsernameKey,
                        token: JSON.stringify(
                            await encryptJson({ token: legacySession.token }),
                        ),
                        obtainedAt:
                            legacySession.obtained_at ??
                            new Date().toISOString(),
                        credentials: JSON.stringify(legacySession.credentials),
                    });
                    migratedSomething = true;
                } catch (error) {
                    console.error(
                        `No se pudo migrar la sesión a SQLite: ${error.message}`,
                    );
                }
            } else {
                migratedSomething = true;
            }
        } else if (legacySession) {
            console.error(
                "session.json no tiene el formato esperado; no se migró.",
            );
        }

        if (migratedSomething) {
            await removeLegacyFile(legacySessionPath);
        }
    }

    if (await pathExists(legacyReadStatePath)) {
        try {
            const readState = JSON.parse(
                await readFile(legacyReadStatePath, "utf8"),
            );
            for (const [username, user] of Object.entries(
                readState?.users ?? {},
            )) {
                if (user?.messages) {
                    importReadMessages(usernameKeyFor(username), user.messages);
                }
            }
            await removeLegacyFile(legacyReadStatePath);
            migratedSomething = true;
        } catch (error) {
            console.error(
                `No se pudo migrar read-state.json: ${error.message}`,
            );
        }
    }

    if (await pathExists(legacyTelegramPath)) {
        try {
            const telegramStore = JSON.parse(
                await readFile(legacyTelegramPath, "utf8"),
            );
            for (const [username, config] of Object.entries(
                telegramStore?.users ?? {},
            )) {
                const key = usernameKeyFor(username);
                if (!getTelegramSettings(key)) {
                    importTelegramSettings(key, config);
                }
            }
            await removeLegacyFile(legacyTelegramPath);
            migratedSomething = true;
        } catch (error) {
            console.error(`No se pudo migrar telegram.json: ${error.message}`);
        }
    }

    await removeLegacyFile(legacyTelegramLockPath);

    if (migratedSomething) {
        console.log(
            "Datos antiguos migrados a SQLite; los JSON de sesión han sido eliminados.",
        );
    }
}

function childFullName(child) {
    return [child.nombreAlumno, child.apellido1Alumno, child.apellido2Alumno]
        .filter(Boolean)
        .join(" ")
        .trim();
}

async function portalRequestWithAuth(account, pathname, options = {}) {
    try {
        let auth = await ensureAccountToken(account);
        const send = () =>
            fetch(`${PORTAL_BASE_URL}${pathname}`, {
                ...options,
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${auth.token}`,
                    ...(options.headers ?? {}),
                },
                signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
            });

        let response = await send();

        if (
            response.status === 401 ||
            (response.status === 500 && isTokenExpired(auth.token))
        ) {
            auth = await refreshAccount(auth.account);
            response = await send();
        }

        return response;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        if (error.name === "TimeoutError" || error.name === "AbortError") {
            throw new ApiError(
                504,
                "El portal de Stilus tardó demasiado en responder. La sesión sigue siendo válida; inténtalo de nuevo.",
                { source: "stilus" },
            );
        }
        throw new ApiError(
            502,
            "No se pudo conectar con el portal de Stilus. La sesión sigue siendo válida; inténtalo de nuevo.",
            { source: "stilus" },
        );
    }
}

async function readPortalResponse(response, action) {
    if (response.ok) {
        const content = await response.text();
        if (!content) {
            return null;
        }
        try {
            return JSON.parse(content);
        } catch {
            return null;
        }
    }

    const body = await response.text().catch(() => "");
    console.error(
        `[portal] ${action}: ${response.status} ${body.slice(0, 500)}`,
    );

    if (response.status === 401) {
        throw new ApiError(
            401,
            "La sesión del portal no es válida. Inicia sesión de nuevo.",
            { source: "stilus", upstreamStatus: 401 },
        );
    }

    throw new ApiError(
        502,
        `El portal de Stilus no está disponible o devolvió un error ${response.status}. La sesión sigue siendo válida; inténtalo de nuevo más tarde.`,
        { source: "stilus", upstreamStatus: response.status },
    );
}

async function fetchChildren(account) {
    const response = await portalRequestWithAuth(
        account,
        "/matriculas/educacyl",
    );
    const data = await readPortalResponse(response, "obtener las matrículas");
    return (data?.datos ?? []).filter((child) => child.habilitada !== false);
}

async function fetchCommunicationsForChild(account, child) {
    const messages = [];
    let page = 1;
    let totalPages = 1;

    do {
        const params = new URLSearchParams({
            clase: "recibidas",
            archivada: "false",
            offset: String(page),
            limit: String(COMMUNICATIONS_PAGE_SIZE),
            sort: "-fechaComunicacion",
        });
        const response = await portalRequestWithAuth(
            account,
            `/comunicaciones/${encodeURIComponent(child.matriculaId)}?${params.toString()}`,
        );
        const data = await readPortalResponse(
            response,
            `obtener las comunicaciones de ${childFullName(child)}`,
        );

        messages.push(...(data?.datos ?? []));
        totalPages = Number(data?.infoPaginacion?.totalNumberOfPages) || 1;
        if (!data?.infoPaginacion?.hasNextPage) {
            break;
        }
        page += 1;
    } while (page <= totalPages && page <= COMMUNICATIONS_MAX_PAGES);

    return messages;
}

function mergeInbox(children, results, readMessages) {
    const messagesByUuid = new Map();

    for (const { child, messages } of results) {
        for (const message of messages) {
            if (!message?.uuid) {
                continue;
            }

            let entry = messagesByUuid.get(message.uuid);
            if (!entry) {
                entry = {
                    ...message,
                    children: [],
                    destinatarios: [],
                    adjuntos: [],
                    is_read: false,
                    read_at: readMessages[message.uuid]?.read_at ?? null,
                    is_archived: false,
                };
                messagesByUuid.set(message.uuid, entry);
            }

            const recipient = (message.destinatarios ?? []).find(
                (item) => item.persId === child.personaId,
            );
            const isChildRead = Boolean(message.leida || recipient?.lectura);

            if (
                !entry.children.some(
                    (item) => item.matriculaId === child.matriculaId,
                )
            ) {
                entry.children.push({
                    matriculaId: child.matriculaId,
                    personaId: child.personaId,
                    nombreCompleto: childFullName(child),
                    nombre: child.nombreAlumno,
                    curso: child.nivelEducativo,
                    grupo: child.codigoGrupo,
                    leida: isChildRead,
                    archivada: Boolean(
                        message.archivada || recipient?.archivada,
                    ),
                });
            }

            for (const destinatario of message.destinatarios ?? []) {
                if (
                    !entry.destinatarios.some(
                        (item) => item.persId === destinatario.persId,
                    )
                ) {
                    entry.destinatarios.push(destinatario);
                }
            }

            for (const adjunto of message.adjuntos ?? []) {
                if (
                    adjunto?.uuid &&
                    adjunto.borrado !== true &&
                    !entry.adjuntos.some((item) => item.uuid === adjunto.uuid)
                ) {
                    entry.adjuntos.push(adjunto);
                }
            }
        }
    }

    const messages = [...messagesByUuid.values()].map((message) => {
        const locallyRead = Boolean(message.read_at);
        const childrenRead =
            message.children.length > 0 &&
            message.children.every((child) => child.leida);

        return {
            ...message,
            is_read: locallyRead || childrenRead,
            is_archived:
                message.children.length > 0 &&
                message.children.every((child) => child.archivada),
            unread_children: message.children
                .filter((child) => !child.leida)
                .map((child) => child.matriculaId),
        };
    });

    messages.sort((first, second) =>
        String(second.fechaComunicacion).localeCompare(
            String(first.fechaComunicacion),
        ),
    );

    const enrichedChildren = children.map((child) => {
        const childMessages = messages.filter((message) =>
            message.children.some(
                (item) => item.matriculaId === child.matriculaId,
            ),
        );

        return {
            matriculaId: child.matriculaId,
            personaId: child.personaId,
            nombreCompleto: childFullName(child),
            nombre: child.nombreAlumno,
            curso: child.nivelEducativo,
            grupo: child.codigoGrupo,
            total: childMessages.length,
            unread: childMessages.filter((message) => !message.is_read).length,
        };
    });

    return {
        children: enrichedChildren,
        messages,
        unread: messages.filter((message) => !message.is_read).length,
    };
}

async function fetchInboxData(account) {
    const auth = await ensureAccountToken(account);
    const current = auth.account;
    const children = await fetchChildren(current);
    const results = await Promise.all(
        children.map(async (child) => ({
            child,
            messages: await fetchCommunicationsForChild(current, child),
        })),
    );

    const readMessages = getUserReadMessages(current.usernameKey);
    const inbox = mergeInbox(children, results, readMessages);
    return { account: current, inbox };
}

async function markPortalRead(account, matriculaIds, uuid) {
    const results = await Promise.allSettled(
        matriculaIds.map(async (matriculaId) => {
            const response = await portalRequestWithAuth(
                account,
                `/comunicaciones/lecturas/${encodeURIComponent(matriculaId)}`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ uuids: [uuid] }),
                },
            );

            if (!response.ok) {
                const body = await response.text().catch(() => "");
                console.error(
                    `[portal] marcar leído ${matriculaId}: ${response.status} ${body.slice(0, 300)}`,
                );
                throw new Error(`HTTP ${response.status}`);
            }
        }),
    );

    return results.every((result) => result.status === "fulfilled");
}

function safeFilename(value, fallback = "adjunto") {
    const base = String(value ?? "")
        .split(/[\\/]/)
        .pop()
        ?.replace(/[\p{Cc}"]/gu, "")
        .trim();
    return (base || fallback).slice(0, 180);
}

function contentDisposition(filename) {
    const fallback =
        filename
            .normalize("NFKD")
            .replace(/[^\x20-\x7E]/g, "_")
            .replace(/["\\]/g, "_") || "adjunto";
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function publicTelegramConfig(config) {
    if (!config) {
        return {
            status: "ok",
            configured: false,
            enabled: false,
            chat_id: null,
            bot_token_hint: null,
            initialized: false,
            last_checked_at: null,
            last_sent_at: null,
            last_error: null,
        };
    }

    return {
        status: "ok",
        configured: true,
        enabled: Boolean(config.enabled),
        chat_id: config.chatId ?? null,
        bot_token_hint: config.botTokenHint ?? null,
        initialized: Boolean(config.initialized),
        last_checked_at: config.lastCheckedAt ?? null,
        last_sent_at: config.lastSentAt ?? null,
        last_error: config.lastError ?? null,
    };
}

async function saveTelegramConfig(usernameKey, { botToken, chatId, enabled }) {
    const previous = getTelegramSettings(usernameKey);
    let encryptedToken = previous?.botToken ?? null;
    let tokenHint = previous?.botTokenHint ?? null;
    const trimmedToken = typeof botToken === "string" ? botToken.trim() : "";

    if (trimmedToken) {
        encryptedToken = JSON.stringify(
            await encryptJson({ token: trimmedToken }),
        );
        tokenHint = trimmedToken.slice(-4);
    }

    if (!encryptedToken) {
        throw new ApiError(422, "Introduce el token del bot de Telegram.");
    }

    const trimmedChatId = typeof chatId === "string" ? chatId.trim() : "";
    const effectiveChatId = trimmedChatId || previous?.chatId || "";

    if (enabled && !effectiveChatId) {
        throw new ApiError(
            422,
            "Introduce el chat ID de Telegram o usa Detectar chat.",
        );
    }

    return upsertTelegramSettings({
        usernameKey,
        enabled: Boolean(enabled),
        chatId: effectiveChatId,
        botToken: encryptedToken,
        botTokenHint: tokenHint,
        initialized: previous?.initialized ?? false,
    });
}

async function baselineTelegram(usernameKey, account = null) {
    try {
        const current = account ?? getAccountByUsernameKey(usernameKey);
        if (!current) {
            throw new Error(
                "No hay una cuenta activa para inicializar Telegram.",
            );
        }

        const { inbox } = await fetchInboxData(current);
        const now = new Date().toISOString();
        baselineTelegramNotified(
            usernameKey,
            inbox.messages.map((message) => message.uuid),
            now,
        );
        updateTelegramStatus(usernameKey, {
            checkedAt: now,
            error: null,
            initialized: true,
        });
    } catch (error) {
        console.error(
            `Telegram: could not initialize the message list: ${error.message}`,
        );
    }
}

async function resolveTelegramCredentials(usernameKey, overrides = {}) {
    const config = getTelegramSettings(usernameKey);
    let token =
        typeof overrides.botToken === "string" ? overrides.botToken.trim() : "";

    if (!token && config?.botToken) {
        try {
            const payload = parseStoredPayload(config.botToken);
            const decrypted = payload ? await decryptJson(payload) : null;
            token = typeof decrypted?.token === "string" ? decrypted.token : "";
        } catch {
            throw new ApiError(
                422,
                "No se pudo leer el token guardado. Vuelve a introducirlo.",
            );
        }
    }

    if (!token) {
        throw new ApiError(422, "Introduce el token del bot de Telegram.");
    }

    const overrideChatId =
        typeof overrides.chatId === "string" ? overrides.chatId.trim() : "";
    const chatId = overrideChatId || (config?.chatId ?? "").trim();

    return { token, chatId, config };
}

async function telegramApi(token, method, payload = {}) {
    let response;
    try {
        response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (error) {
        throw new ApiError(
            502,
            `No se pudo conectar con Telegram: ${error.message}`,
        );
    }

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
        throw new ApiError(
            502,
            `Telegram: ${data?.description ?? `HTTP ${response.status}`}`,
        );
    }
    return data.result;
}

async function discoverTelegramChats(token) {
    const updates = await telegramApi(token, "getUpdates", {
        timeout: 0,
        allowed_updates: ["message"],
    });

    const chats = new Map();
    for (const update of updates ?? []) {
        const chat = update.message?.chat ?? update.edited_message?.chat;
        if (!chat?.id) {
            continue;
        }
        const name =
            [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
            chat.title ||
            chat.username ||
            String(chat.id);
        chats.set(String(chat.id), {
            id: String(chat.id),
            name,
            username: chat.username ?? null,
        });
    }

    return [...chats.values()].reverse().slice(0, 10);
}

function splitTelegramText(text, maxLength = 4000) {
    const chunks = [];
    let remaining = String(text ?? "").trim();

    while (remaining.length > maxLength) {
        let cut = remaining.lastIndexOf("\n", maxLength);
        if (cut < Math.floor(maxLength * 0.6)) {
            cut = maxLength;
        }
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).replace(/^\n+/, "").trim();
    }

    if (remaining) {
        chunks.push(remaining);
    }
    return chunks.length ? chunks : ["(Sin contenido)"];
}

function formatTelegramDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return String(value ?? "");
    }
    return new Intl.DateTimeFormat("es-ES", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function decodeHtmlEntities(value) {
    return String(value ?? "")
        .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
            try {
                return String.fromCodePoint(Number.parseInt(hex, 16));
            } catch {
                return match;
            }
        })
        .replace(/&#(\d+);/g, (match, number) => {
            try {
                return String.fromCodePoint(Number(number));
            } catch {
                return match;
            }
        })
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");
}

function telegramMessageText(message) {
    const sender = message.remitente?.nombreCompleto ?? "Stilus";
    const children =
        (message.children ?? [])
            .map((child) => child.nombreCompleto)
            .join(", ") || "—";
    const body = decodeHtmlEntities(message.texto)
        .replace(/\{@link:(.*?)\}/g, "$1")
        .replace(/<((?:https?:\/\/)[^>]+)>/g, "$1")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\r\n/g, "\n")
        .trim();

    const lines = [
        `📬 ${message.asunto || "(Sin asunto)"}`,
        `De: ${sender}`,
        `Para: ${children}`,
        `Fecha: ${formatTelegramDate(message.fechaComunicacion)}`,
        `Tipo: ${message.tipoComunicacion?.descripcion ?? "MENSAJE"}`,
    ];

    if (message.adjuntos?.length) {
        lines.push(`Adjuntos: ${message.adjuntos.length}`);
    }
    if (body) {
        lines.push("", body);
    }

    return lines.join("\n");
}

async function telegramSendText(token, chatId, text) {
    for (const chunk of splitTelegramText(text)) {
        await telegramApi(token, "sendMessage", {
            chat_id: chatId,
            text: chunk,
            disable_web_page_preview: true,
        });
    }
}

async function telegramSendDocument(token, chatId, attachment, account) {
    const portalResponse = await portalRequestWithAuth(
        account,
        `/adjuntos/${encodeURIComponent(attachment.uuid)}`,
        { headers: { Accept: "*/*" } },
    );

    if (!portalResponse.ok) {
        throw new ApiError(
            502,
            `No se pudo descargar el adjunto ${attachment.nombre}.`,
        );
    }

    const buffer = Buffer.from(await portalResponse.arrayBuffer());
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append(
        "document",
        new Blob([buffer], {
            type: attachment.mediaType || "application/octet-stream",
        }),
        attachment.nombre || "adjunto",
    );

    let response;
    try {
        response = await fetch(
            `${TELEGRAM_API_BASE}/bot${token}/sendDocument`,
            {
                method: "POST",
                body: form,
                signal: AbortSignal.timeout(120_000),
            },
        );
    } catch {
        throw new ApiError(
            502,
            `No se pudo enviar el adjunto ${attachment.nombre} a Telegram.`,
        );
    }

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
        throw new ApiError(
            502,
            `Telegram no pudo enviar ${attachment.nombre}: ${
                data?.description ?? `HTTP ${response.status}`
            }`,
        );
    }
}

async function sendTelegramMessage(token, chatId, message, account) {
    await telegramSendText(token, chatId, telegramMessageText(message));

    const failed = [];
    for (const attachment of message.adjuntos ?? []) {
        try {
            await telegramSendDocument(token, chatId, attachment, account);
        } catch (error) {
            console.error(
                `Telegram: could not send attachment ${attachment.nombre}: ${error.message}`,
            );
            failed.push(attachment.nombre ?? "adjunto");
        }
    }

    if (failed.length) {
        try {
            await telegramSendText(
                token,
                chatId,
                `⚠️ No se pudieron enviar estos adjuntos: ${failed.join(", ")}`,
            );
        } catch (error) {
            console.error(`Telegram error: ${error.message}`);
        }
    }
}

let telegramPollInFlight = false;
const telegramPollOwner = `${process.pid}-${randomBytes(8).toString("hex")}`;

async function processTelegramTarget({ account, settings }) {
    const usernameKey = account.usernameKey;
    if (
        !claimTelegramLock(usernameKey, telegramPollOwner, TELEGRAM_LOCK_TTL_MS)
    ) {
        return;
    }

    try {
        const botPayload = parseStoredPayload(settings.botToken);
        if (!botPayload) {
            throw new Error("No hay un token de bot guardado.");
        }

        let botToken;
        try {
            const decrypted = await decryptJson(botPayload);
            botToken = decrypted?.token;
        } catch (error) {
            throw new Error(
                `No se pudo descifrar el token del bot: ${error.message}`,
            );
        }

        if (typeof botToken !== "string" || !botToken) {
            throw new Error("El token del bot guardado no es válido.");
        }

        const { inbox } = await fetchInboxData(account);
        const checkedAt = new Date().toISOString();

        if (!settings.initialized) {
            baselineTelegramNotified(
                usernameKey,
                inbox.messages.map((message) => message.uuid),
                checkedAt,
            );
            updateTelegramStatus(usernameKey, {
                checkedAt,
                error: null,
                initialized: true,
            });
            return;
        }

        const notified = getTelegramNotified(usernameKey);
        const newMessages = inbox.messages
            .filter((message) => !notified[message.uuid])
            .sort((first, second) =>
                String(first.fechaComunicacion).localeCompare(
                    String(second.fechaComunicacion),
                ),
            );

        let failure = null;

        for (const message of newMessages) {
            try {
                await sendTelegramMessage(
                    botToken,
                    settings.chatId,
                    message,
                    account,
                );
                const sentAt = new Date().toISOString();
                markTelegramNotified(usernameKey, message.uuid, sentAt);
                updateTelegramStatus(usernameKey, {
                    sentAt,
                    error: null,
                });
                console.log(
                    `Telegram: sent "${message.asunto}" (${message.uuid}) for ${account.username}.`,
                );
            } catch (error) {
                failure = error;
                console.error(
                    `Telegram: could not notify message ${message.uuid} for ${account.username}: ${error.message}`,
                );
                break;
            }
        }

        updateTelegramStatus(usernameKey, {
            checkedAt: new Date().toISOString(),
            error: failure ? failure.message : null,
        });
    } catch (error) {
        console.error(
            `Telegram error for ${account.username}: ${error.message}`,
        );
        updateTelegramStatus(usernameKey, {
            checkedAt: new Date().toISOString(),
            error: error.message,
        });
    } finally {
        releaseTelegramLock(usernameKey, telegramPollOwner);
    }
}

async function pollTelegramNotifications({ usernameKey = null } = {}) {
    if (telegramPollInFlight) {
        return;
    }

    telegramPollInFlight = true;

    try {
        const targets = listTelegramTargets(usernameKey);
        for (const target of targets) {
            await processTelegramTarget(target);
        }
    } catch (error) {
        console.error(`Telegram error: ${error.message}`);
    } finally {
        telegramPollInFlight = false;
    }
}

const app = express();
app.disable("x-powered-by");
app.use(cookieParser());
app.use(express.json({ limit: "16kb" }));

app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Vary", "Origin");
        response.setHeader(
            "Access-Control-Allow-Methods",
            "GET, POST, PATCH, DELETE, OPTIONS",
        );
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (request.method === "OPTIONS") {
        response.sendStatus(204);
        return;
    }
    next();
});

let python;
try {
    python = resolvePython();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const hasFrontend = await pathExists(FRONTEND_INDEX);
await migrateLegacyState();

function requireJson(request, response, next) {
    if (!request.is("application/json")) {
        response
            .status(415)
            .json({ detail: "Se requiere Content-Type application/json." });
        return;
    }
    next();
}

app.get("/api/health", (request, response) => {
    response.json({ status: "ok" });
});

app.get("/api/token", async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        const auth = await ensureAccountToken(account);
        response.json({
            ...sessionPayload(auth.account, auth.token, auth.renewed),
            message: auth.renewed ? "Token renovado." : "Token actual.",
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/token/refresh", requireJson, async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        const auth = await refreshAccount(account);
        response.json({
            ...sessionPayload(auth.account, auth.token, true),
            message: "Token renovado correctamente.",
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/login", requireJson, async (request, response, next) => {
    try {
        const { username, password } = request.body ?? {};

        if (
            typeof username !== "string" ||
            typeof password !== "string" ||
            !username.trim() ||
            !password
        ) {
            throw new ApiError(
                422,
                "El usuario y la contraseña son obligatorios.",
            );
        }

        const normalizedUsername = username.trim();
        const { account, token } = await enqueueAuthentication(() =>
            loginAndPersist(normalizedUsername, password),
        );

        const previousSession = request.cookies?.[WEB_SESSION_COOKIE];
        if (previousSession) {
            deleteWebSession(hashSessionId(previousSession));
        }
        startWebSession(response, account.id);

        response.json({
            ...sessionPayload(account, token),
            message:
                "Autenticación correcta. La sesión se renovará cuando sea necesario.",
            saved_to: DATABASE_FILE_NAME,
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/logout", requireJson, async (request, response, next) => {
    try {
        endWebSession(request, response);
        response.json({
            status: "ok",
            message:
                "Sesión del navegador cerrada. La cuenta y la configuración de Telegram permanecen guardadas hasta que se eliminen.",
        });
    } catch (error) {
        next(error);
    }
});

app.delete("/api/account", async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        deleteAccountData(account.usernameKey);
        endWebSession(request, response);
        response.json({
            status: "ok",
            message:
                "Cuenta eliminada del servidor, junto con su estado de lectura y la configuración de Telegram.",
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/inbox", async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        const { inbox } = await fetchInboxData(account);

        response.set("Cache-Control", "no-store");
        response.json({
            status: "ok",
            fetched_at: new Date().toISOString(),
            ...inbox,
        });
    } catch (error) {
        next(error);
    }
});

app.post(
    "/api/inbox/:uuid/read",
    requireJson,
    async (request, response, next) => {
        try {
            const { account } = requireWebSession(request);
            const { uuid } = request.params;

            if (!UUID_PATTERN.test(uuid)) {
                throw new ApiError(
                    400,
                    "El identificador del mensaje no es válido.",
                );
            }

            const requested = Array.isArray(request.body?.matricula_ids)
                ? request.body.matricula_ids
                : [];
            const matriculaIds = [
                ...new Set(
                    requested
                        .map(Number)
                        .filter(
                            (value) => Number.isInteger(value) && value > 0,
                        ),
                ),
            ];

            if (!matriculaIds.length) {
                throw new ApiError(
                    422,
                    "Faltan los destinatarios del mensaje.",
                );
            }

            const read = markMessageLocallyRead(
                account.usernameKey,
                uuid,
                matriculaIds,
            );
            const portalUpdated = await markPortalRead(
                account,
                matriculaIds,
                uuid,
            );

            response.json({
                status: "ok",
                uuid,
                read_at: read.read_at,
                portal_updated: portalUpdated,
                ...(portalUpdated
                    ? {}
                    : {
                          warning:
                              "El estado se guardó en el servidor, pero no se pudo actualizar en Stilus.",
                      }),
            });
        } catch (error) {
            next(error);
        }
    },
);

app.get("/api/attachments/:uuid", async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        const { uuid } = request.params;

        if (!UUID_PATTERN.test(uuid)) {
            throw new ApiError(
                400,
                "El identificador del adjunto no es válido.",
            );
        }

        const portalResponse = await portalRequestWithAuth(
            account,
            `/adjuntos/${encodeURIComponent(uuid)}`,
            { headers: { Accept: "*/*" } },
        );

        if (!portalResponse.ok) {
            const body = await portalResponse.text().catch(() => "");
            console.error(
                `[portal] descargar adjunto ${uuid}: ${portalResponse.status} ${body.slice(0, 300)}`,
            );
            throw new ApiError(
                portalResponse.status === 401 ? 401 : 502,
                "No se pudo descargar el adjunto.",
            );
        }

        const filename = safeFilename(request.query.name, `adjunto-${uuid}`);
        const contentType =
            portalResponse.headers.get("content-type") ??
            "application/octet-stream";
        const buffer = Buffer.from(await portalResponse.arrayBuffer());

        response.setHeader("Content-Type", contentType);
        response.setHeader("Content-Disposition", contentDisposition(filename));
        response.setHeader("Content-Length", buffer.length);
        response.setHeader("Cache-Control", "private, max-age=300");
        response.send(buffer);
    } catch (error) {
        next(error);
    }
});

app.get("/api/telegram", async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        const config = getTelegramSettings(account.usernameKey);
        response.json(publicTelegramConfig(config));
    } catch (error) {
        next(error);
    }
});

app.post("/api/telegram", requireJson, async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        const { bot_token, chat_id, enabled } = request.body ?? {};

        if (bot_token !== undefined && typeof bot_token !== "string") {
            throw new ApiError(422, "El token del bot no es válido.");
        }
        if (chat_id !== undefined && typeof chat_id !== "string") {
            throw new ApiError(422, "El chat ID no es válido.");
        }

        const wantsEnabled = enabled !== false;
        const saved = await saveTelegramConfig(account.usernameKey, {
            botToken: typeof bot_token === "string" ? bot_token : "",
            chatId: typeof chat_id === "string" ? chat_id : "",
            enabled: wantsEnabled,
        });

        if (saved.enabled && !saved.initialized) {
            await baselineTelegram(account.usernameKey, account);
        }

        const config = getTelegramSettings(account.usernameKey);
        response.json({
            ...publicTelegramConfig(config),
            message: saved.enabled
                ? "Integración con Telegram guardada."
                : "Notificaciones de Telegram desactivadas.",
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/telegram/test", requireJson, async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        const { bot_token, chat_id } = request.body ?? {};

        if (bot_token !== undefined && typeof bot_token !== "string") {
            throw new ApiError(422, "El token del bot no es válido.");
        }
        if (chat_id !== undefined && typeof chat_id !== "string") {
            throw new ApiError(422, "El chat ID no es válido.");
        }

        const credentials = await resolveTelegramCredentials(
            account.usernameKey,
            {
                botToken: typeof bot_token === "string" ? bot_token : "",
                chatId: typeof chat_id === "string" ? chat_id : "",
            },
        );

        if (!credentials.chatId) {
            throw new ApiError(
                422,
                "Falta el chat ID de Telegram. Usa Detectar chat.",
            );
        }

        await telegramApi(credentials.token, "sendMessage", {
            chat_id: credentials.chatId,
            text: "✅ Stilus: prueba de conexión correcta. Las notificaciones llegarán a este chat.",
            disable_web_page_preview: true,
        });

        response.json({
            status: "ok",
            message: "Mensaje de prueba enviado a Telegram.",
        });
    } catch (error) {
        next(error);
    }
});

app.post(
    "/api/telegram/discover",
    requireJson,
    async (request, response, next) => {
        try {
            const { account } = requireWebSession(request);
            const { bot_token } = request.body ?? {};

            if (bot_token !== undefined && typeof bot_token !== "string") {
                throw new ApiError(422, "El token del bot no es válido.");
            }

            const { token } = await resolveTelegramCredentials(
                account.usernameKey,
                {
                    botToken: typeof bot_token === "string" ? bot_token : "",
                },
            );

            const result = await discoverTelegramChats(token);
            response.json({
                status: "ok",
                chats: result,
                message: result.length
                    ? "Chat detectado."
                    : "No hay chats. Abre el bot en Telegram y envía /start.",
            });
        } catch (error) {
            next(error);
        }
    },
);

app.delete("/api/telegram", async (request, response, next) => {
    try {
        const { account } = requireWebSession(request);
        deleteTelegramSettings(account.usernameKey);
        response.json({
            status: "ok",
            message: "Integración con Telegram eliminada.",
        });
    } catch (error) {
        next(error);
    }
});

app.use("/api", (request, response) => {
    response.status(404).json({ detail: "Ruta no encontrada." });
});

if (hasFrontend) {
    app.use(express.static(FRONTEND_DIR));
    app.use((request, response, next) => {
        if (request.method !== "GET") {
            next();
            return;
        }
        response.sendFile(FRONTEND_INDEX);
    });
} else {
    app.get("/", (request, response) => {
        response.json({
            message:
                "API de Stilus activa. Arranca el frontend con `npm run dev` o consulta /api/health.",
        });
    });
}

app.use((request, response) => {
    response.status(404).json({ detail: "Ruta no encontrada." });
});

app.use((error, request, response, next) => {
    if (response.headersSent) {
        next(error);
        return;
    }

    if (error instanceof ApiError) {
        response.status(error.status).json({
            detail: error.message,
            ...(error.source ? { source: error.source } : {}),
            ...(error.upstreamStatus
                ? { upstream_status: error.upstreamStatus }
                : {}),
        });
        return;
    }

    if (error?.type === "entity.parse.failed") {
        response
            .status(400)
            .json({ detail: "El cuerpo de la petición no es un JSON válido." });
        return;
    }

    console.error(error);
    response.status(500).json({ detail: "Error inesperado en el servidor." });
});

const isMainModule =
    Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    app.listen(PORT, HOST, () => {
        console.log(`API de Stilus escuchando en http://${HOST}:${PORT}`);
        console.log(`Python: ${python}`);
        console.log(
            `Base de datos: ${DATABASE_FILE_NAME} · sesiones por cookie y renovación bajo demanda`,
        );
        console.log(
            hasFrontend
                ? `Frontend: ${FRONTEND_DIR}`
                : "Frontend: ejecuta `npm run dev` en frontend/",
        );
    });

    const telegramTimer = setInterval(
        pollTelegramNotifications,
        TELEGRAM_POLL_INTERVAL_MS,
    );
    telegramTimer.unref();
    void pollTelegramNotifications();
}

export {
    baselineTelegram,
    discoverTelegramChats,
    loginAndPersist,
    pollTelegramNotifications,
    publicTelegramConfig,
    saveTelegramConfig,
};
