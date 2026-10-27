import { useState } from "react";
import { EyeIcon, LockIcon } from "./icons";
import StatusAlert from "./StatusAlert";
import ThemeToggle from "./ThemeToggle";

export default function LoginScreen({
    checking,
    loading,
    status,
    onLogin,
    theme,
    onToggleTheme,
}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);

    async function handleSubmit(event) {
        event.preventDefault();
        if (loading) {
            return;
        }

        const success = await onLogin(username.trim(), password);
        if (success) {
            setPassword("");
        }
    }

    return (
        <main className="page">
            <div className="glow glow--one" aria-hidden="true" />
            <div className="glow glow--two" aria-hidden="true" />

            <section className="card" aria-labelledby="login-title">
                <ThemeToggle
                    theme={theme}
                    onToggle={onToggleTheme}
                    className="theme-switch--card"
                />
                <header className="card__header">
                    <span className="brand" aria-hidden="true">
                        S
                    </span>
                    <p className="eyebrow">Portal Stilus Familias</p>
                    <h1 id="login-title">Accede a tu cuenta</h1>
                    <p className="subtitle">
                        Introduce tus credenciales de Educa. La sesión se guarda
                        cifrada y el token se renueva solo.
                    </p>
                </header>

                {checking ? (
                    <div className="checking">
                        <span
                            className="spinner spinner--muted"
                            aria-hidden="true"
                        />
                        Comprobando la sesión guardada…
                    </div>
                ) : (
                    <>
                        <form
                            className="form"
                            onSubmit={handleSubmit}
                            noValidate
                        >
                            <div className="field">
                                <label htmlFor="username">Usuario</label>
                                <input
                                    id="username"
                                    name="username"
                                    type="email"
                                    autoComplete="username"
                                    placeholder="nombre.apellido@educa.jcyl.es"
                                    value={username}
                                    onChange={(event) =>
                                        setUsername(event.target.value)
                                    }
                                    disabled={loading}
                                    required
                                />
                            </div>

                            <div className="field">
                                <label htmlFor="password">Contraseña</label>
                                <div className="password">
                                    <input
                                        id="password"
                                        name="password"
                                        type={
                                            showPassword ? "text" : "password"
                                        }
                                        autoComplete="current-password"
                                        placeholder="Tu contraseña"
                                        value={password}
                                        onChange={(event) =>
                                            setPassword(event.target.value)
                                        }
                                        disabled={loading}
                                        required
                                    />
                                    <button
                                        type="button"
                                        className="password__toggle"
                                        onClick={() =>
                                            setShowPassword(
                                                (visible) => !visible,
                                            )
                                        }
                                        aria-label={
                                            showPassword
                                                ? "Ocultar contraseña"
                                                : "Mostrar contraseña"
                                        }
                                        aria-pressed={showPassword}
                                        disabled={loading}
                                    >
                                        <EyeIcon crossed={showPassword} />
                                    </button>
                                </div>
                            </div>

                            <button
                                type="submit"
                                className="submit"
                                disabled={
                                    loading || !username.trim() || !password
                                }
                            >
                                {loading ? (
                                    <>
                                        <span
                                            className="spinner"
                                            aria-hidden="true"
                                        />
                                        Conectando con Stilus…
                                    </>
                                ) : (
                                    <>
                                        <LockIcon />
                                        Iniciar sesión
                                    </>
                                )}
                            </button>
                        </form>

                        <div className="feedback">
                            <StatusAlert status={status} />
                        </div>

                        <p className="note">
                            La contraseña se guarda cifrada y solo se usa para
                            renovar el token automáticamente.
                        </p>
                    </>
                )}
            </section>
        </main>
    );
}
