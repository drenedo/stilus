import { MoonIcon, SunIcon } from "./icons";

export default function ThemeToggle({ theme, onToggle, className = "" }) {
    const isLight = theme === "light";

    return (
        <button
            type="button"
            className={`theme-switch ${
                isLight ? "theme-switch--light" : ""
            } ${className}`.trim()}
            onClick={onToggle}
            role="switch"
            aria-checked={isLight}
            aria-label={
                isLight ? "Cambiar a tema oscuro" : "Cambiar a tema claro"
            }
            title={
                isLight
                    ? "Tema claro · cambiar a oscuro"
                    : "Tema oscuro · cambiar a claro"
            }
        >
            <span
                className="theme-switch__icon theme-switch__sun"
                aria-hidden="true"
            >
                <SunIcon />
            </span>
            <span
                className="theme-switch__icon theme-switch__moon"
                aria-hidden="true"
            >
                <MoonIcon />
            </span>
            <span className="theme-switch__thumb" aria-hidden="true" />
        </button>
    );
}
