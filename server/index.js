import { spawn, spawnSync } from "node:child_process";
import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    randomUUID,
} from "node:crypto";
import {
    closeSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import {
    access,
    chmod,
    mkdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SERVER_DIR, "..");
const DATA_DIR = path.resolve(process.env.STILUS_DATA_DIR || ROOT_DIR);
const SCRIPT_PATH = path.join(ROOT_DIR, "get_token.py");
const SESSION_PATH = path.join(DATA_DIR, "session.json");
const KEY_PATH = path.join(DATA_DIR, ".session.key");
const CONFIG_PATH =
    process.env.STILUS_CONFIG || path.join(ROOT_DIR, "config.yaml");
const FRONTEND_DIR = path.join(ROOT_DIR, "frontend", "dist");
const FRONTEND_INDEX = path.join(FRONTEND_DIR, "index.html");
const SESSION_FILE_NAME = path.basename(SESSION_PATH);
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || "127.0.0.1";
const LOGIN_TIMEOUT_MS = 120_000;
const READ_STATE_PATH = path.join(DATA_DIR, "read-state.json");
const TELEGRAM_STORE_PATH = path.join(DATA_DIR, "telegram.json");
const TELEGRAM_LOCK_PATH = path.join(DATA_DIR, "telegram.lock");
const TELEGRAM_API_BASE =
    process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const TELEGRAM_POLL_INTERVAL_MS = 5 * 60 * 1000;
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

try {
    await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
    if (DATA_DIR !== ROOT_DIR) {
        await chmod(DATA_DIR, 0o700).catch(() => {});
    }
} catch (error) {
    console.error(
        `Could not create data directory ${DATA_DIR}: ${error.message}`,
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

function isValidSession(session) {
    return Boolean(
        session &&
        typeof session === "object" &&
        typeof session.id === "string" &&
        typeof session.username === "string" &&
        typeof session.token === "string" &&
        session.token &&
        session.credentials,
    );
}

async function readSession() {
    let content;
    try {
        content = await readFile(SESSION_PATH, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }

    try {
        const session = JSON.parse(content);
        if (!isValidSession(session)) {
            throw new Error("La sesión guardada no tiene el formato esperado.");
        }
        return session;
    } catch (error) {
        console.error(`No se pudo leer ${SESSION_FILE_NAME}: ${error.message}`);
        return null;
    }
}

async function requireSession() {
    const session = await readSession();
    if (!session?.token) {
        throw new ApiError(
            401,
            "No hay una sesión guardada. Inicia sesión para continuar.",
        );
    }
    return session;
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

function isTokenExpired(session) {
    const expiry = getTokenExpiry(session.token);
    return expiry !== null && expiry <= Date.now();
}

async function ensureValidSession() {
    const session = await requireSession();
    if (!isTokenExpired(session)) {
        return { session, renewed: false };
    }
    return refreshSession();
}

let sessionWriteQueue = Promise.resolve();

function persistSession(session) {
    const operation = sessionWriteQueue.then(async () => {
        const temporaryPath = `${SESSION_PATH}.tmp`;
        await writeFile(
            temporaryPath,
            `${JSON.stringify(session, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        await chmod(temporaryPath, 0o600).catch(() => {});
        await rename(temporaryPath, SESSION_PATH);
    });

    sessionWriteQueue = operation.catch(() => {});
    return operation;
}

async function clearSession() {
    await sessionWriteQueue.catch(() => {});
    try {
        await unlink(SESSION_PATH);
    } catch (error) {
        if (error.code !== "ENOENT") {
            throw error;
        }
    }
}

async function createSession(token, username, password, id = randomUUID()) {
    return {
        id,
        username,
        token,
        obtained_at: new Date().toISOString(),
        credentials: await encryptJson({ username, password }),
    };
}

function sessionPayload(session, renewed = false) {
    return {
        status: "ok",
        username: session.username,
        token: session.token,
        obtained_at: session.obtained_at,
        renewed,
    };
}

// Selenium opens a browser per login, so authentications are serialized.
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
    const session = await createSession(token, username, password);
    await persistSession(session);
    return session;
}

let refreshPromise = null;

function refreshSession() {
    if (refreshPromise) {
        return refreshPromise;
    }

    refreshPromise = (async () => {
        const session = await requireSession();

        let credentials;
        try {
            credentials = await decryptJson(session.credentials);
        } catch (error) {
            console.error(
                `No se pudieron descifrar las credenciales guardadas: ${error.message}`,
            );
            await clearSession();
            throw new ApiError(
                401,
                "La sesión guardada no es válida. Vuelve a iniciar sesión.",
            );
        }

        if (
            typeof credentials?.username !== "string" ||
            typeof credentials?.password !== "string"
        ) {
            await clearSession();
            throw new ApiError(
                401,
                "La sesión guardada no es válida. Vuelve a iniciar sesión.",
            );
        }

        let outcome;
        try {
            outcome = await enqueueAuthentication(async () => {
                const token = await getTokenFromPython(
                    python,
                    credentials.username,
                    credentials.password,
                );

                const current = await readSession();
                // The user may have logged out or signed in with another account.
                if (!current || current.id !== session.id) {
                    return {
                        session: current,
                        renewed: false,
                        superseded: true,
                    };
                }

                const renewedSession = await createSession(
                    token,
                    credentials.username,
                    credentials.password,
                    session.id,
                );
                await persistSession(renewedSession);
                return {
                    session: renewedSession,
                    renewed: true,
                    superseded: false,
                };
            });
        } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
                await clearSession();
            }
            throw error;
        }

        if (outcome.superseded) {
            if (outcome.session) {
                return { session: outcome.session, renewed: false };
            }
            throw new ApiError(
                401,
                "La sesión cambió mientras se renovaba el token. Inicia sesión de nuevo.",
            );
        }

        console.log(`Token renewed for ${credentials.username}.`);
        return { session: outcome.session, renewed: outcome.renewed };
    })().finally(() => {
        refreshPromise = null;
    });

    return refreshPromise;
}

let readStateQueue = Promise.resolve();

async function readReadState() {
    try {
        const content = await readFile(READ_STATE_PATH, "utf8");
        const state = JSON.parse(content);
        if (!state || typeof state !== "object" || !state.users) {
            return { users: {} };
        }
        return state;
    } catch (error) {
        if (error.code === "ENOENT") {
            return { users: {} };
        }
        console.error(
            `No se pudo leer ${path.basename(READ_STATE_PATH)}: ${error.message}`,
        );
        return { users: {} };
    }
}

function updateReadState(mutator) {
    const operation = readStateQueue.then(async () => {
        const state = await readReadState();
        if (!state.users) {
            state.users = {};
        }
        const result = await mutator(state);
        const temporaryPath = `${READ_STATE_PATH}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await chmod(temporaryPath, 0o600).catch(() => {});
        await rename(temporaryPath, READ_STATE_PATH);
        return result;
    });

    readStateQueue = operation.catch(() => {});
    return operation;
}

function getUserReadMessages(state, username) {
    const messages = state.users?.[username]?.messages;
    if (!messages || typeof messages !== "object") {
        return {};
    }
    return messages;
}

function markMessageLocallyRead(username, uuid, matriculaIds) {
    return updateReadState((state) => {
        const user = state.users[username] ?? { messages: {} };
        if (!user.messages || typeof user.messages !== "object") {
            user.messages = {};
        }
        state.users[username] = user;

        const previous = user.messages[uuid] ?? {};
        const ids = new Set([
            ...(Array.isArray(previous.matricula_ids)
                ? previous.matricula_ids
                : []),
            ...matriculaIds,
        ]);
        user.messages[uuid] = {
            read_at: previous.read_at ?? new Date().toISOString(),
            matricula_ids: [...ids],
        };
        return user.messages[uuid];
    });
}

function childFullName(child) {
    return [child.nombreAlumno, child.apellido1Alumno, child.apellido2Alumno]
        .filter(Boolean)
        .join(" ")
        .trim();
}

async function portalRequestWithAuth(pathname, options = {}) {
    try {
        let { session } = await ensureValidSession();
        let response = await fetch(`${PORTAL_BASE_URL}${pathname}`, {
            ...options,
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${session.token}`,
                ...(options.headers ?? {}),
            },
            signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
        });

        if (
            response.status === 401 ||
            (response.status === 500 && isTokenExpired(session))
        ) {
            const refreshed = await refreshSession();
            session = refreshed.session;
            response = await fetch(`${PORTAL_BASE_URL}${pathname}`, {
                ...options,
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${session.token}`,
                    ...(options.headers ?? {}),
                },
                signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
            });
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

async function fetchChildren() {
    const response = await portalRequestWithAuth("/matriculas/educacyl");
    const data = await readPortalResponse(response, "obtener las matrículas");
    return (data?.datos ?? []).filter((child) => child.habilitada !== false);
}

async function fetchCommunicationsForChild(child) {
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

async function fetchInboxData() {
    const { session } = await ensureValidSession();
    const children = await fetchChildren();
    const results = await Promise.all(
        children.map(async (child) => ({
            child,
            messages: await fetchCommunicationsForChild(child),
        })),
    );

    const readState = await readReadState();
    const readMessages = getUserReadMessages(readState, session.username);
    const inbox = mergeInbox(children, results, readMessages);
    return { session, inbox };
}

async function markPortalRead(matriculaIds, uuid) {
    const results = await Promise.allSettled(
        matriculaIds.map(async (matriculaId) => {
            const response = await portalRequestWithAuth(
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

let telegramStoreQueue = Promise.resolve();

function acquireTelegramLock() {
    const pid = String(process.pid);

    try {
        const descriptor = openSync(TELEGRAM_LOCK_PATH, "wx", 0o600);
        writeSync(descriptor, pid);
        closeSync(descriptor);
        return true;
    } catch (error) {
        if (error.code !== "EEXIST") {
            throw error;
        }
    }

    try {
        const existing = Number(
            readFileSync(TELEGRAM_LOCK_PATH, "utf8").trim(),
        );

        if (existing && existing !== process.pid) {
            try {
                process.kill(existing, 0);
                return false;
            } catch (error) {
                if (error.code !== "ESRCH") {
                    return false;
                }
                unlinkSync(TELEGRAM_LOCK_PATH);
                return acquireTelegramLock();
            }
        }

        return false;
    } catch {
        try {
            unlinkSync(TELEGRAM_LOCK_PATH);
        } catch {
            // Ignore cleanup errors and retry once.
        }
        return acquireTelegramLock();
    }
}

function releaseTelegramLock() {
    try {
        const existing = Number(
            readFileSync(TELEGRAM_LOCK_PATH, "utf8").trim(),
        );
        if (existing === process.pid) {
            unlinkSync(TELEGRAM_LOCK_PATH);
        }
    } catch {
        // The lock may have already been removed.
    }
}

async function readTelegramStore() {
    try {
        const content = await readFile(TELEGRAM_STORE_PATH, "utf8");
        const store = JSON.parse(content);
        if (
            !store ||
            typeof store !== "object" ||
            !store.users ||
            typeof store.users !== "object"
        ) {
            return { users: {} };
        }
        return store;
    } catch (error) {
        if (error.code === "ENOENT") {
            return { users: {} };
        }
        console.error(
            `No se pudo leer ${path.basename(TELEGRAM_STORE_PATH)}: ${error.message}`,
        );
        return { users: {} };
    }
}

function updateTelegramStore(mutator) {
    const operation = telegramStoreQueue.then(async () => {
        const store = await readTelegramStore();
        if (!store.users) {
            store.users = {};
        }
        const result = await mutator(store);
        const temporaryPath = `${TELEGRAM_STORE_PATH}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        await chmod(temporaryPath, 0o600).catch(() => {});
        await rename(temporaryPath, TELEGRAM_STORE_PATH);
        return result;
    });

    telegramStoreQueue = operation.catch(() => {});
    return operation;
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
        chat_id: config.chat_id ?? null,
        bot_token_hint: config.bot_token_hint ?? null,
        initialized: Boolean(config.initialized),
        last_checked_at: config.last_checked_at ?? null,
        last_sent_at: config.last_sent_at ?? null,
        last_error: config.last_error ?? null,
    };
}

async function getTelegramConfig(username) {
    const store = await readTelegramStore();
    return store.users?.[username] ?? null;
}

async function saveTelegramConfig(username, { botToken, chatId, enabled }) {
    const now = new Date().toISOString();

    return updateTelegramStore(async (store) => {
        const previous = store.users[username] ?? null;
        let encryptedToken = previous?.bot_token ?? null;
        let tokenHint = previous?.bot_token_hint ?? null;
        const trimmedToken =
            typeof botToken === "string" ? botToken.trim() : "";

        if (trimmedToken) {
            encryptedToken = await encryptJson({ token: trimmedToken });
            tokenHint = trimmedToken.slice(-4);
        }

        if (!encryptedToken) {
            throw new ApiError(422, "Introduce el token del bot de Telegram.");
        }

        const trimmedChatId = typeof chatId === "string" ? chatId.trim() : "";
        const effectiveChatId = trimmedChatId || previous?.chat_id || "";

        if (enabled && !effectiveChatId) {
            throw new ApiError(
                422,
                "Introduce el chat ID de Telegram o usa Detectar chat.",
            );
        }

        const config = {
            ...(previous ?? {}),
            enabled: Boolean(enabled),
            chat_id: effectiveChatId,
            bot_token: encryptedToken,
            bot_token_hint: tokenHint,
            updated_at: now,
            initialized: previous?.initialized ?? false,
            notified: previous?.notified ?? {},
            last_checked_at: previous?.last_checked_at ?? null,
            last_sent_at: previous?.last_sent_at ?? null,
            last_error: previous?.last_error ?? null,
        };

        store.users[username] = config;
        return config;
    });
}

async function baselineTelegram(username) {
    try {
        const { inbox } = await fetchInboxData();
        const now = new Date().toISOString();

        await updateTelegramStore((store) => {
            const config = store.users[username];
            if (!config) {
                return;
            }
            config.initialized = true;
            config.notified = Object.fromEntries(
                inbox.messages.map((message) => [message.uuid, now]),
            );
            config.last_checked_at = now;
            config.last_error = null;
        });
    } catch (error) {
        console.error(
            `Telegram: could not initialize the message list: ${error.message}`,
        );
    }
}

async function resolveTelegramCredentials(username, overrides = {}) {
    const config = await getTelegramConfig(username);
    let token =
        typeof overrides.botToken === "string" ? overrides.botToken.trim() : "";

    if (!token && config?.bot_token) {
        try {
            const decrypted = await decryptJson(config.bot_token);
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
    const chatId = overrideChatId || (config?.chat_id ?? "").trim();

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

async function telegramSendDocument(token, chatId, attachment) {
    const portalResponse = await portalRequestWithAuth(
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

async function sendTelegramMessage(token, chatId, message) {
    await telegramSendText(token, chatId, telegramMessageText(message));

    const failed = [];
    for (const attachment of message.adjuntos ?? []) {
        try {
            await telegramSendDocument(token, chatId, attachment);
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

async function pollTelegramNotifications() {
    if (telegramPollInFlight) {
        return;
    }

    let locked = false;
    try {
        locked = acquireTelegramLock();
    } catch (error) {
        console.error(`Telegram: could not acquire the lock: ${error.message}`);
        return;
    }

    if (!locked) {
        return;
    }

    telegramPollInFlight = true;

    try {
        const session = await readSession();
        if (!session?.username) {
            return;
        }

        const config = await getTelegramConfig(session.username);
        if (!config?.enabled || !config.bot_token || !config.chat_id) {
            return;
        }

        let credentials;
        try {
            credentials = await decryptJson(config.bot_token);
        } catch (error) {
            console.error(
                `Telegram: could not decrypt the stored token: ${error.message}`,
            );
            return;
        }

        if (!credentials?.token) {
            return;
        }

        const { inbox } = await fetchInboxData();
        const now = new Date().toISOString();

        if (!config.initialized) {
            await updateTelegramStore((store) => {
                const current = store.users[session.username];
                if (!current) {
                    return;
                }
                current.initialized = true;
                current.notified = Object.fromEntries(
                    inbox.messages.map((message) => [message.uuid, now]),
                );
                current.last_checked_at = now;
                current.last_error = null;
            });
            return;
        }

        const notified = config.notified ?? {};
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
                    credentials.token,
                    config.chat_id,
                    message,
                );
                const sentAt = new Date().toISOString();
                await updateTelegramStore((store) => {
                    const current = store.users[session.username];
                    if (!current) {
                        return;
                    }
                    current.notified = {
                        ...(current.notified ?? {}),
                        [message.uuid]: sentAt,
                    };
                    current.last_sent_at = sentAt;
                    current.last_error = null;
                });
                console.log(
                    `Telegram: sent "${message.asunto}" (${message.uuid}).`,
                );
            } catch (error) {
                failure = error;
                console.error(
                    `Telegram: could not notify message ${message.uuid}: ${error.message}`,
                );
                break;
            }
        }

        await updateTelegramStore((store) => {
            const current = store.users[session.username];
            if (current) {
                current.last_checked_at = new Date().toISOString();
                current.last_error = failure ? failure.message : null;
            }
        });
    } catch (error) {
        console.error(`Telegram error: ${error.message}`);
    } finally {
        telegramPollInFlight = false;
        releaseTelegramLock();
    }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use((request, response, next) => {
    const origin = request.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        response.setHeader(
            "Access-Control-Allow-Methods",
            "GET, POST, DELETE, OPTIONS",
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
        const { session, renewed } = await ensureValidSession();
        response.json({
            ...sessionPayload(session, renewed),
            message: renewed ? "Token renovado." : "Token actual.",
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/token/refresh", requireJson, async (request, response, next) => {
    try {
        const { session, renewed } = await refreshSession();
        response.json({
            ...sessionPayload(session, renewed),
            message: renewed
                ? "Token renovado correctamente."
                : "Token actual.",
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
        const session = await enqueueAuthentication(() =>
            loginAndPersist(normalizedUsername, password),
        );

        response.json({
            ...sessionPayload(session),
            message:
                "Autenticación correcta. La sesión se renovará cuando sea necesario.",
            saved_to: SESSION_FILE_NAME,
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/logout", requireJson, async (request, response, next) => {
    try {
        await clearSession();
        response.json({
            status: "ok",
            message:
                "Sesión eliminada. Las credenciales guardadas se han borrado.",
        });
    } catch (error) {
        next(error);
    }
});

app.get("/api/inbox", async (request, response, next) => {
    try {
        const { inbox } = await fetchInboxData();

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
            const session = await requireSession();
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

            const read = await markMessageLocallyRead(
                session.username,
                uuid,
                matriculaIds,
            );
            const portalUpdated = await markPortalRead(matriculaIds, uuid);

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
        const { uuid } = request.params;

        if (!UUID_PATTERN.test(uuid)) {
            throw new ApiError(
                400,
                "El identificador del adjunto no es válido.",
            );
        }

        const portalResponse = await portalRequestWithAuth(
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
        const session = await requireSession();
        const config = await getTelegramConfig(session.username);
        response.json(publicTelegramConfig(config));
    } catch (error) {
        next(error);
    }
});

app.post("/api/telegram", requireJson, async (request, response, next) => {
    try {
        const session = await requireSession();
        const { bot_token, chat_id, enabled } = request.body ?? {};

        if (bot_token !== undefined && typeof bot_token !== "string") {
            throw new ApiError(422, "El token del bot no es válido.");
        }
        if (chat_id !== undefined && typeof chat_id !== "string") {
            throw new ApiError(422, "El chat ID no es válido.");
        }

        const wantsEnabled = enabled !== false;
        const saved = await saveTelegramConfig(session.username, {
            botToken: typeof bot_token === "string" ? bot_token : "",
            chatId: typeof chat_id === "string" ? chat_id : "",
            enabled: wantsEnabled,
        });

        if (saved.enabled && !saved.initialized) {
            await baselineTelegram(session.username);
        }

        const config = await getTelegramConfig(session.username);
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
        const session = await requireSession();
        const { bot_token, chat_id } = request.body ?? {};

        if (bot_token !== undefined && typeof bot_token !== "string") {
            throw new ApiError(422, "El token del bot no es válido.");
        }
        if (chat_id !== undefined && typeof chat_id !== "string") {
            throw new ApiError(422, "El chat ID no es válido.");
        }

        const credentials = await resolveTelegramCredentials(session.username, {
            botToken: typeof bot_token === "string" ? bot_token : "",
            chatId: typeof chat_id === "string" ? chat_id : "",
        });

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
            const session = await requireSession();
            const { bot_token } = request.body ?? {};

            if (bot_token !== undefined && typeof bot_token !== "string") {
                throw new ApiError(422, "El token del bot no es válido.");
            }

            const { token } = await resolveTelegramCredentials(
                session.username,
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
        const session = await requireSession();
        await updateTelegramStore((store) => {
            delete store.users[session.username];
        });
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
        console.log(`Sesión: ${SESSION_FILE_NAME} · renovación bajo demanda`);
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
    readSession,
    releaseTelegramLock,
    saveTelegramConfig,
};
