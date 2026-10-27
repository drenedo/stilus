import { useCallback, useEffect, useState } from "react";
import Inbox from "./Inbox";
import LoginScreen from "./LoginScreen";
import { deleteAccount, getToken, login, logout, refreshToken } from "./api";

const TOKEN_POLL_MS = 5 * 60 * 1000;
const THEME_STORAGE_KEY = "stilus.theme";

function getInitialTheme() {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === "light" || stored === "dark") {
            return stored;
        }
    } catch {
        // Storage may be unavailable in private or restricted contexts.
    }

    if (window.matchMedia("(prefers-color-scheme: light)").matches) {
        return "light";
    }
    return "dark";
}

function toSession(data) {
    return {
        username: data.username,
        obtained_at: data.obtained_at,
    };
}

export default function App() {
    const [session, setSession] = useState(null);
    const [checking, setChecking] = useState(true);
    const [status, setStatus] = useState(null);
    const [loginLoading, setLoginLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const [theme, setTheme] = useState(getInitialTheme);
    const activeUsername = session?.username ?? null;

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.colorScheme = theme;

        const themeColor = document.querySelector('meta[name="theme-color"]');
        if (themeColor) {
            themeColor.setAttribute(
                "content",
                theme === "light" ? "#edf3f8" : "#0b1220",
            );
        }
    }, [theme]);

    useEffect(() => {
        const media = window.matchMedia("(prefers-color-scheme: light)");

        function handleSystemThemeChange(event) {
            let stored = null;
            try {
                stored = localStorage.getItem(THEME_STORAGE_KEY);
            } catch {
                // Fall back to following the system preference.
            }
            if (stored === "light" || stored === "dark") {
                return;
            }
            setTheme(event.matches ? "light" : "dark");
        }

        media.addEventListener("change", handleSystemThemeChange);
        return () => {
            media.removeEventListener("change", handleSystemThemeChange);
        };
    }, []);

    useEffect(() => {
        document.title = session ? "Stilus · Mensajes" : "Stilus · Acceso";
    }, [session]);

    useEffect(() => {
        let active = true;

        (async () => {
            try {
                const data = await getToken();
                if (active) {
                    setSession(toSession(data));
                }
            } catch (error) {
                if (active && error.status !== 401) {
                    setStatus({ type: "error", message: error.message });
                }
            } finally {
                if (active) {
                    setChecking(false);
                }
            }
        })();

        return () => {
            active = false;
        };
    }, []);

    const handleUnauthorized = useCallback((message) => {
        setSession(null);
        setStatus({
            type: "error",
            message:
                message ||
                "La sesión guardada ya no es válida. Inicia sesión de nuevo.",
        });
    }, []);

    const handleToggleTheme = useCallback(() => {
        setTheme((current) => {
            const next = current === "light" ? "dark" : "light";
            try {
                localStorage.setItem(THEME_STORAGE_KEY, next);
            } catch {
                // The theme still applies for this session.
            }
            return next;
        });
    }, []);

    useEffect(() => {
        if (!activeUsername) {
            return undefined;
        }

        let active = true;

        async function syncSession() {
            try {
                const data = await getToken();
                if (active) {
                    setSession(toSession(data));
                }
            } catch (error) {
                if (!active) {
                    return;
                }
                if (error.status === 401) {
                    handleUnauthorized(
                        "La sesión guardada ya no es válida. Inicia sesión de nuevo.",
                    );
                }
            }
        }

        const interval = setInterval(syncSession, TOKEN_POLL_MS);

        function handleVisibilityChange() {
            if (document.visibilityState === "visible") {
                syncSession();
            }
        }

        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            active = false;
            clearInterval(interval);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [activeUsername, handleUnauthorized]);

    const handleLogin = useCallback(async (username, password) => {
        setStatus(null);
        setLoginLoading(true);

        try {
            const data = await login(username, password);
            setSession(toSession(data));
            setStatus(null);
            return true;
        } catch (error) {
            setStatus({ type: "error", message: error.message });
            return false;
        } finally {
            setLoginLoading(false);
        }
    }, []);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        setStatus(null);

        try {
            const data = await refreshToken();
            setSession(toSession(data));
            setStatus({
                type: "success",
                message: "Token renovado correctamente.",
            });
        } catch (error) {
            if (error.status === 401) {
                setSession(null);
            }
            setStatus({ type: "error", message: error.message });
        } finally {
            setRefreshing(false);
        }
    }, []);

    const handleLogout = useCallback(async () => {
        setLoggingOut(true);

        try {
            await logout();
            setSession(null);
            setStatus(null);
        } catch (error) {
            setStatus({ type: "error", message: error.message });
        } finally {
            setLoggingOut(false);
        }
    }, []);

    const handleDeleteAccount = useCallback(async () => {
        if (
            !window.confirm(
                "¿Eliminar la cuenta guardada, su estado de lectura y la configuración de Telegram? Esta acción no se puede deshacer.",
            )
        ) {
            return false;
        }

        setLoggingOut(true);

        try {
            await deleteAccount();
            setSession(null);
            setStatus({
                type: "success",
                message: "Cuenta y datos guardados eliminados.",
            });
            return true;
        } catch (error) {
            setStatus({ type: "error", message: error.message });
            return false;
        } finally {
            setLoggingOut(false);
        }
    }, []);

    if (session) {
        return (
            <Inbox
                session={session}
                authStatus={status}
                onRefresh={handleRefresh}
                refreshing={refreshing}
                onLogout={handleLogout}
                onDeleteAccount={handleDeleteAccount}
                loggingOut={loggingOut}
                onUnauthorized={handleUnauthorized}
                theme={theme}
                onToggleTheme={handleToggleTheme}
            />
        );
    }

    return (
        <LoginScreen
            checking={checking}
            loading={loginLoading}
            status={status}
            onLogin={handleLogin}
            theme={theme}
            onToggleTheme={handleToggleTheme}
        />
    );
}
