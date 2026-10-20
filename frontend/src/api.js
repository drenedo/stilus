const REQUEST_TIMEOUT_MS = 130_000;

export class ApiError extends Error {
    constructor(message, status = 0, options = {}) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.source = options.source ?? null;
        this.upstreamStatus = options.upstreamStatus ?? null;
    }
}

async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === "AbortError") {
            throw new ApiError(
                "La operación tardó demasiado. Comprueba tu conexión e inténtalo de nuevo.",
            );
        }
        throw new ApiError(
            "No se pudo conectar con el servidor. Comprueba que la API está arrancada.",
        );
    } finally {
        clearTimeout(timeout);
    }

    let data = null;
    try {
        data = await response.json();
    } catch {
        // The API may return an empty or non-JSON body on unexpected failures.
    }

    if (!response.ok) {
        const detail = data?.detail;
        throw new ApiError(
            typeof detail === "string"
                ? detail
                : "No se pudo completar la operación.",
            response.status,
            {
                source: typeof data?.source === "string" ? data.source : null,
                upstreamStatus: Number.isInteger(data?.upstream_status)
                    ? data.upstream_status
                    : null,
            },
        );
    }

    return data;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function login(username, password) {
    return request("/api/login", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ username, password }),
    });
}

export function getToken() {
    return request("/api/token");
}

export function refreshToken() {
    return request("/api/token/refresh", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
    });
}

export function logout() {
    return request("/api/logout", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
    });
}

export function getInbox() {
    return request("/api/inbox");
}

export function markMessageRead(uuid, matriculaIds) {
    return request(`/api/inbox/${encodeURIComponent(uuid)}/read`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ matricula_ids: matriculaIds }),
    });
}

export function getTelegramConfig() {
    return request("/api/telegram");
}

export function saveTelegramConfig(payload) {
    return request("/api/telegram", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
    });
}

export function testTelegramConnection(payload) {
    return request("/api/telegram/test", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
    });
}

export function discoverTelegramChat(payload) {
    return request("/api/telegram/discover", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
    });
}

export function deleteTelegramConfig() {
    return request("/api/telegram", { method: "DELETE" });
}
