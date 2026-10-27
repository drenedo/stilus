import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    deleteTelegramConfig,
    discoverTelegramChat,
    getInbox,
    getTelegramConfig,
    markMessageRead,
    saveTelegramConfig,
    testTelegramConnection,
} from "./api";
import StatusAlert from "./StatusAlert";
import ThemeToggle from "./ThemeToggle";
import {
    AlertIcon,
    ArrowLeftIcon,
    CheckIcon,
    ChevronDownIcon,
    DownloadIcon,
    FileIcon,
    InboxIcon,
    LogoutIcon,
    PaperclipIcon,
    RefreshIcon,
    SearchIcon,
} from "./icons";
import "./inbox.css";

const AUTO_REFRESH_MS = 10 * 60 * 1000;

const AVATAR_GRADIENTS = [
    "linear-gradient(145deg, #fbbf24, #b45309)",
    "linear-gradient(145deg, #34d399, #0f766e)",
    "linear-gradient(145deg, #60a5fa, #1d4ed8)",
    "linear-gradient(145deg, #f472b6, #9d174d)",
    "linear-gradient(145deg, #a78bfa, #5b21b6)",
    "linear-gradient(145deg, #fb7185, #9f1239)",
    "linear-gradient(145deg, #22d3ee, #0e7490)",
];

const MARKDOWN_COMPONENTS = {
    a: ({ node, ...props }) => (
        <a {...props} target="_blank" rel="noreferrer" />
    ),
};

function titleCase(value = "") {
    return value
        .toLocaleLowerCase("es")
        .replace(
            /(^|[\s-])(\p{L})/gu,
            (_, prefix, letter) => prefix + letter.toLocaleUpperCase("es"),
        );
}

function normalizeSenderName(value = "") {
    return String(value).trim().toLocaleLowerCase("es");
}

function initials(value = "") {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
        return "?";
    }
    const first = parts[0][0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return `${first}${last}`.toLocaleUpperCase("es");
}

function hashName(value = "") {
    let hash = 0;
    for (const character of value) {
        hash = (hash * 31 + character.codePointAt(0)) % 100000;
    }
    return hash;
}

function avatarGradient(value) {
    return AVATAR_GRADIENTS[hashName(value) % AVATAR_GRADIENTS.length];
}

function typeColor(message) {
    const raw = message?.tipoComunicacion?.codigoAuxiliar ?? "";
    const match = raw.match(/#[0-9a-fA-F]{3,8}/);
    return match ? match[0] : "#3dd6b5";
}

function formatListDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return new Intl.DateTimeFormat("es-ES", {
            hour: "2-digit",
            minute: "2-digit",
        }).format(date);
    }

    return new Intl.DateTimeFormat("es-ES", {
        day: "2-digit",
        month: "short",
        ...(date.getFullYear() === now.getFullYear()
            ? {}
            : { year: "numeric" }),
    }).format(date);
}

function formatFullDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "Fecha desconocida";
    }
    return new Intl.DateTimeFormat("es-ES", {
        dateStyle: "long",
        timeStyle: "short",
    }).format(date);
}

function portalIssueTitle(issue) {
    if (!issue) {
        return "";
    }
    if (issue.upstreamStatus) {
        return `Stilus no está disponible (error ${issue.upstreamStatus})`;
    }
    if (issue.status === 504) {
        return "Stilus está tardando demasiado";
    }
    return "No se pudo conectar con Stilus";
}

function previewText(text = "") {
    return text
        .replace(/\{@link:(.*?)\}/g, "$1")
        .replace(/<https?:\/\/[^>]+>/g, "")
        .replace(/[*_#`~]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 150);
}

function prepareMarkdown(text = "") {
    return text.replace(/\{@link:(.*?)\}/g, "[$1]($1)");
}

function attachmentUrl(attachment) {
    const uuid = encodeURIComponent(attachment.uuid);
    const name = encodeURIComponent(attachment.nombre ?? "adjunto");
    return `/api/attachments/${uuid}?name=${name}`;
}

function attachmentType(mediaType = "") {
    if (mediaType === "application/pdf") {
        return "PDF";
    }
    if (mediaType.startsWith("image/")) {
        return "Imagen";
    }
    if (mediaType.includes("wordprocessingml")) {
        return "Documento Word";
    }
    if (mediaType.includes("spreadsheetml") || mediaType.includes("ms-excel")) {
        return "Hoja de cálculo";
    }
    if (mediaType.includes("presentationml")) {
        return "Presentación";
    }
    if (mediaType.startsWith("text/")) {
        return "Texto";
    }
    return "Archivo";
}

function downloadAllAttachments(attachments) {
    attachments.forEach((attachment, index) => {
        setTimeout(() => {
            const link = document.createElement("a");
            link.href = attachmentUrl(attachment);
            link.download = attachment.nombre ?? "adjunto";
            document.body.appendChild(link);
            link.click();
            link.remove();
        }, index * 350);
    });
}

function MessageItem({ message, selected, onSelect }) {
    const sender = titleCase(message.remitente?.nombreCompleto ?? "Stilus");
    const color = typeColor(message);

    return (
        <li>
            <button
                type="button"
                className={`message-item ${
                    message.is_read ? "" : "message-item--unread"
                } ${selected ? "message-item--selected" : ""}`.trim()}
                onClick={() => onSelect(message)}
                aria-current={selected ? "true" : undefined}
            >
                <span
                    className="message-item__avatar"
                    style={{ background: avatarGradient(sender) }}
                    aria-hidden="true"
                >
                    {initials(sender)}
                </span>

                <span className="message-item__main">
                    <span className="message-item__row">
                        <span className="message-item__sender">{sender}</span>
                        <time
                            className="message-item__date"
                            dateTime={message.fechaComunicacion}
                        >
                            {formatListDate(message.fechaComunicacion)}
                        </time>
                    </span>

                    <span className="message-item__subject">
                        {!message.is_read && (
                            <span className="unread-dot" aria-hidden="true" />
                        )}
                        <span>{message.asunto || "(Sin asunto)"}</span>
                    </span>

                    <span className="message-item__preview">
                        {previewText(message.texto) || "Sin contenido."}
                    </span>

                    <span className="message-item__footer">
                        <span
                            className="type-badge"
                            style={{
                                color,
                                borderColor: `${color}55`,
                                backgroundColor: `${color}14`,
                            }}
                        >
                            {message.tipoComunicacion?.descripcion ?? "MENSAJE"}
                        </span>
                        {message.children.map((child) => (
                            <span
                                className="child-badge"
                                key={child.matriculaId}
                            >
                                {titleCase(child.nombre)}
                            </span>
                        ))}
                        {(message.adjuntos?.length ?? 0) > 0 && (
                            <span
                                className="attachment-count"
                                title={`${message.adjuntos.length} adjunto${
                                    message.adjuntos.length === 1 ? "" : "s"
                                }`}
                            >
                                <PaperclipIcon />
                                {message.adjuntos.length}
                            </span>
                        )}
                    </span>
                </span>
            </button>
        </li>
    );
}

function MessageDetail({ message, onBack, onMarkRead }) {
    const sender = titleCase(message.remitente?.nombreCompleto ?? "Stilus");
    const color = typeColor(message);

    return (
        <article className="message-detail">
            <div className="message-detail__toolbar">
                <button type="button" className="back-button" onClick={onBack}>
                    <ArrowLeftIcon />
                    Volver
                </button>
                <span
                    className="type-badge"
                    style={{
                        color,
                        borderColor: `${color}55`,
                        backgroundColor: `${color}14`,
                    }}
                >
                    {message.tipoComunicacion?.descripcion ?? "MENSAJE"}
                </span>
            </div>

            <h2 className="message-detail__subject">
                {message.asunto || "(Sin asunto)"}
            </h2>

            <div className="message-detail__meta">
                <span
                    className="message-detail__avatar"
                    style={{ background: avatarGradient(sender) }}
                    aria-hidden="true"
                >
                    {initials(sender)}
                </span>
                <div className="message-detail__from">
                    <strong>{sender}</strong>
                    <span>{formatFullDate(message.fechaComunicacion)}</span>
                </div>
                <div className="message-detail__to">
                    <span>Para</span>
                    {message.children.map((child) => (
                        <span className="child-badge" key={child.matriculaId}>
                            {titleCase(child.nombreCompleto)}
                        </span>
                    ))}
                </div>
            </div>

            {(message.adjuntos?.length ?? 0) > 0 && (
                <section className="message-attachments">
                    <div className="message-attachments__head">
                        <span className="message-attachments__title">
                            <PaperclipIcon />
                            {message.adjuntos.length}{" "}
                            {message.adjuntos.length === 1
                                ? "adjunto"
                                : "adjuntos"}
                        </span>
                        {message.adjuntos.length > 1 && (
                            <button
                                type="button"
                                className="attachment-download-all"
                                onClick={() =>
                                    downloadAllAttachments(message.adjuntos)
                                }
                            >
                                Descargar todo
                            </button>
                        )}
                    </div>

                    <ul className="attachment-list">
                        {message.adjuntos.map((attachment) => (
                            <li key={attachment.uuid}>
                                <a
                                    className="attachment"
                                    href={attachmentUrl(attachment)}
                                    download={attachment.nombre ?? "adjunto"}
                                >
                                    <span className="attachment__icon">
                                        <FileIcon
                                            mediaType={attachment.mediaType}
                                        />
                                    </span>
                                    <span className="attachment__info">
                                        <span className="attachment__name">
                                            {attachment.nombre}
                                        </span>
                                        <span className="attachment__type">
                                            {attachmentType(
                                                attachment.mediaType,
                                            )}
                                        </span>
                                    </span>
                                    <span className="attachment__download">
                                        <DownloadIcon />
                                    </span>
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <div className="message-detail__body">
                {message.texto ? (
                    <ReactMarkdown
                        components={MARKDOWN_COMPONENTS}
                        remarkPlugins={[remarkGfm]}
                    >
                        {prepareMarkdown(message.texto)}
                    </ReactMarkdown>
                ) : (
                    <p>Sin contenido.</p>
                )}
            </div>

            <footer className="message-detail__footer">
                {message.is_read ? (
                    <span className="read-state">
                        <CheckIcon />
                        Leído
                    </span>
                ) : (
                    <button
                        type="button"
                        className="ghost-button"
                        onClick={() => onMarkRead(message)}
                    >
                        Marcar como leído
                    </button>
                )}
                {message.tipoRespuesta?.descripcion && (
                    <span className="message-detail__reply">
                        {titleCase(message.tipoRespuesta.descripcion)}
                    </span>
                )}
            </footer>
        </article>
    );
}

function EmptyDetail() {
    return (
        <div className="message-detail message-detail--empty">
            <InboxIcon />
            <h2>Selecciona un mensaje</h2>
            <p>
                Elige una comunicación de la lista para leerla. Se marcará como
                leída automáticamente.
            </p>
        </div>
    );
}

function InboxSkeleton() {
    return (
        <div className="inbox-grid">
            <div className="message-list-panel">
                {Array.from({ length: 6 }).map((_, index) => (
                    <div className="skeleton-row" key={index}>
                        <span className="skeleton-avatar" />
                        <span className="skeleton-content">
                            <span className="skeleton-line skeleton-line--short" />
                            <span className="skeleton-line" />
                            <span className="skeleton-line skeleton-line--tiny" />
                        </span>
                    </div>
                ))}
            </div>
            <div className="message-detail-panel message-detail--empty">
                <span className="spinner spinner--muted" aria-hidden="true" />
                <p>Cargando mensajes…</p>
            </div>
        </div>
    );
}

function AccountMenu({
    session,
    authStatus,
    onRefresh,
    refreshing,
    onLogout,
    onDeleteAccount,
    loggingOut,
}) {
    const detailsRef = useRef(null);
    const [tab, setTab] = useState("account");
    const [telegram, setTelegram] = useState(null);
    const [telegramLoading, setTelegramLoading] = useState(false);
    const [telegramSaving, setTelegramSaving] = useState(false);
    const [telegramTesting, setTelegramTesting] = useState(false);
    const [telegramDiscovering, setTelegramDiscovering] = useState(false);
    const [telegramDeleting, setTelegramDeleting] = useState(false);
    const [telegramStatus, setTelegramStatus] = useState(null);
    const [telegramForm, setTelegramForm] = useState({
        bot_token: "",
        chat_id: "",
        enabled: true,
    });

    useEffect(() => {
        function handleDocumentClick(event) {
            if (
                detailsRef.current &&
                !detailsRef.current.contains(event.target)
            ) {
                detailsRef.current.removeAttribute("open");
            }
        }

        function handleKeyDown(event) {
            if (event.key === "Escape" && detailsRef.current) {
                detailsRef.current.removeAttribute("open");
            }
        }

        document.addEventListener("click", handleDocumentClick);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("click", handleDocumentClick);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, []);

    async function loadTelegram() {
        setTelegramLoading(true);
        setTelegramStatus(null);

        try {
            const data = await getTelegramConfig();
            setTelegram(data);
            setTelegramForm({
                bot_token: "",
                chat_id: data.chat_id ?? "",
                enabled: data.configured ? data.enabled : true,
            });
        } catch (error) {
            setTelegramStatus({ type: "error", message: error.message });
        } finally {
            setTelegramLoading(false);
        }
    }

    function handleTab(nextTab) {
        setTab(nextTab);
        if (nextTab === "telegram" && telegram === null && !telegramLoading) {
            void loadTelegram();
        }
    }

    async function handleTelegramSave(event) {
        event.preventDefault();
        if (telegramSaving) {
            return;
        }

        const token = telegramForm.bot_token.trim();
        const chatId = telegramForm.chat_id.trim();

        if (!token && !telegram?.configured) {
            setTelegramStatus({
                type: "error",
                message: "Introduce el token del bot de Telegram.",
            });
            return;
        }
        if (telegramForm.enabled && !chatId) {
            setTelegramStatus({
                type: "error",
                message: "Introduce el chat ID o usa Detectar chat.",
            });
            return;
        }

        setTelegramSaving(true);
        setTelegramStatus(null);

        try {
            const data = await saveTelegramConfig({
                bot_token: token,
                chat_id: chatId,
                enabled: telegramForm.enabled,
            });
            setTelegram(data);
            setTelegramForm({
                bot_token: "",
                chat_id: data.chat_id ?? "",
                enabled: data.enabled ?? true,
            });
            setTelegramStatus({
                type: "success",
                message: data.message ?? "Integración con Telegram guardada.",
            });
        } catch (error) {
            setTelegramStatus({ type: "error", message: error.message });
        } finally {
            setTelegramSaving(false);
        }
    }

    async function handleTelegramTest() {
        if (telegramTesting) {
            return;
        }

        const token = telegramForm.bot_token.trim();
        const chatId = telegramForm.chat_id.trim();

        if (!token && !telegram?.configured) {
            setTelegramStatus({
                type: "error",
                message: "Introduce el token del bot de Telegram.",
            });
            return;
        }
        if (!chatId) {
            setTelegramStatus({
                type: "error",
                message: "Introduce el chat ID o usa Detectar chat.",
            });
            return;
        }

        setTelegramTesting(true);
        setTelegramStatus(null);

        try {
            const data = await testTelegramConnection({
                bot_token: token,
                chat_id: chatId,
            });
            setTelegramStatus({
                type: "success",
                message: data.message ?? "Mensaje de prueba enviado.",
            });
        } catch (error) {
            setTelegramStatus({ type: "error", message: error.message });
        } finally {
            setTelegramTesting(false);
        }
    }

    async function handleTelegramDiscover() {
        if (telegramDiscovering) {
            return;
        }

        const token = telegramForm.bot_token.trim();

        if (!token && !telegram?.configured) {
            setTelegramStatus({
                type: "error",
                message: "Introduce primero el token del bot.",
            });
            return;
        }

        setTelegramDiscovering(true);
        setTelegramStatus(null);

        try {
            const data = await discoverTelegramChat({ bot_token: token });
            const chat = data.chats?.[0];

            if (!chat) {
                setTelegramStatus({
                    type: "error",
                    message:
                        data.message ??
                        "No se detectó ningún chat. Abre el bot y envía /start.",
                });
                return;
            }

            setTelegramForm((current) => ({
                ...current,
                chat_id: chat.id,
            }));
            setTelegramStatus({
                type: "success",
                message: `Chat detectado: ${chat.name} (${chat.id}).`,
            });
        } catch (error) {
            setTelegramStatus({ type: "error", message: error.message });
        } finally {
            setTelegramDiscovering(false);
        }
    }

    async function handleTelegramDelete() {
        if (
            !window.confirm(
                "¿Eliminar la integración con Telegram? Se borrará el token guardado y dejarán de enviarse mensajes.",
            )
        ) {
            return;
        }

        setTelegramDeleting(true);
        setTelegramStatus(null);

        try {
            const data = await deleteTelegramConfig();
            setTelegram(null);
            setTelegramForm({
                bot_token: "",
                chat_id: "",
                enabled: true,
            });
            setTelegramStatus({
                type: "success",
                message: data.message ?? "Integración con Telegram eliminada.",
            });
        } catch (error) {
            setTelegramStatus({ type: "error", message: error.message });
        } finally {
            setTelegramDeleting(false);
        }
    }

    return (
        <details className="account" ref={detailsRef}>
            <summary className="account__summary">
                <span className="account__avatar" aria-hidden="true">
                    {session.username.slice(0, 1).toLocaleUpperCase("es")}
                </span>
                <span className="account__name" title={session.username}>
                    {session.username}
                </span>
                <span className="account__chevron" aria-hidden="true">
                    <ChevronDownIcon />
                </span>
            </summary>

            <div className="account__panel">
                <div className="account__head">
                    <span
                        className="account__avatar account__avatar--large"
                        aria-hidden="true"
                    >
                        {session.username.slice(0, 1).toLocaleUpperCase("es")}
                    </span>
                    <div>
                        <strong>{session.username}</strong>
                        <span>Sesión activa</span>
                    </div>
                </div>

                <div
                    className="account__tabs"
                    role="tablist"
                    aria-label="Ajustes de la cuenta"
                >
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === "account"}
                        className={`account__tab ${
                            tab === "account" ? "account__tab--active" : ""
                        }`.trim()}
                        onClick={() => setTab("account")}
                    >
                        Cuenta
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === "telegram"}
                        className={`account__tab ${
                            tab === "telegram" ? "account__tab--active" : ""
                        }`.trim()}
                        onClick={() => handleTab("telegram")}
                    >
                        Telegram
                        {telegram?.enabled && (
                            <span
                                className="account__tab-dot"
                                aria-label="Notificaciones activas"
                            />
                        )}
                    </button>
                </div>

                {tab === "account" ? (
                    <>
                        <StatusAlert status={authStatus} />

                        <dl className="account__dates">
                            <div>
                                <dt>Generado</dt>
                                <dd>{formatFullDate(session.obtained_at)}</dd>
                            </div>
                        </dl>

                        <p className="account__note">
                            El token de sesión se gestiona en el servidor y no
                            se muestra aquí. La cuenta se conserva para renovar
                            el token y enviar notificaciones de Telegram.
                        </p>

                        <button
                            type="button"
                            className="secondary"
                            onClick={onRefresh}
                            disabled={refreshing || loggingOut}
                        >
                            {refreshing ? (
                                <>
                                    <span
                                        className="spinner spinner--muted"
                                        aria-hidden="true"
                                    />
                                    Renovando…
                                </>
                            ) : (
                                <>
                                    <RefreshIcon />
                                    Renovar token
                                </>
                            )}
                        </button>

                        <button
                            type="button"
                            className="secondary secondary--danger"
                            onClick={onLogout}
                            disabled={refreshing || loggingOut}
                        >
                            {loggingOut ? (
                                "Cerrando…"
                            ) : (
                                <>
                                    <LogoutIcon />
                                    Cerrar sesión
                                </>
                            )}
                        </button>

                        <button
                            type="button"
                            className="secondary secondary--danger"
                            onClick={onDeleteAccount}
                            disabled={refreshing || loggingOut}
                        >
                            Eliminar cuenta y datos guardados
                        </button>
                    </>
                ) : telegramLoading ? (
                    <div className="account__loading">
                        <span
                            className="spinner spinner--muted"
                            aria-hidden="true"
                        />
                        Cargando integración…
                    </div>
                ) : (
                    <form
                        className="telegram-form"
                        onSubmit={handleTelegramSave}
                    >
                        <p className="telegram-help">
                            Recibe cada mensaje nuevo y sus adjuntos en
                            Telegram. El token se guarda cifrado en el servidor.
                        </p>

                        <label className="field field--compact">
                            <span>Token del bot</span>
                            <input
                                type="password"
                                value={telegramForm.bot_token}
                                onChange={(event) =>
                                    setTelegramForm((current) => ({
                                        ...current,
                                        bot_token: event.target.value,
                                    }))
                                }
                                placeholder={
                                    telegram?.configured
                                        ? "Dejar vacío para mantener el actual"
                                        : "123456789:ABC..."
                                }
                                autoComplete="new-password"
                                spellCheck="false"
                                disabled={telegramSaving}
                            />
                        </label>

                        {telegram?.bot_token_hint && (
                            <p className="field__hint">
                                Token guardado: ••••{telegram.bot_token_hint}
                            </p>
                        )}

                        <div className="telegram-chat-row">
                            <label className="field field--compact">
                                <span>Chat ID</span>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    value={telegramForm.chat_id}
                                    onChange={(event) =>
                                        setTelegramForm((current) => ({
                                            ...current,
                                            chat_id: event.target.value,
                                        }))
                                    }
                                    placeholder="123456789"
                                    disabled={telegramSaving}
                                />
                            </label>
                            <button
                                type="button"
                                className="ghost-button"
                                onClick={handleTelegramDiscover}
                                disabled={
                                    telegramDiscovering ||
                                    telegramSaving ||
                                    telegramTesting
                                }
                            >
                                {telegramDiscovering ? "Buscando…" : "Detectar"}
                            </button>
                        </div>

                        <p className="field__hint">
                            Abre tu bot en Telegram, pulsa /start y usa Detectar
                            chat.
                        </p>

                        <label className="toggle">
                            <input
                                type="checkbox"
                                checked={telegramForm.enabled}
                                onChange={(event) =>
                                    setTelegramForm((current) => ({
                                        ...current,
                                        enabled: event.target.checked,
                                    }))
                                }
                                disabled={telegramSaving}
                            />
                            <span>Activar notificaciones</span>
                        </label>

                        <StatusAlert status={telegramStatus} />

                        <div className="telegram-actions">
                            <button
                                type="submit"
                                className="submit submit--compact"
                                disabled={
                                    telegramSaving ||
                                    telegramTesting ||
                                    telegramDeleting
                                }
                            >
                                {telegramSaving ? (
                                    <>
                                        <span
                                            className="spinner"
                                            aria-hidden="true"
                                        />
                                        Guardando…
                                    </>
                                ) : (
                                    "Guardar"
                                )}
                            </button>
                            <button
                                type="button"
                                className="secondary"
                                onClick={handleTelegramTest}
                                disabled={
                                    telegramTesting ||
                                    telegramSaving ||
                                    telegramDeleting
                                }
                            >
                                {telegramTesting ? "Enviando…" : "Probar"}
                            </button>
                        </div>

                        {telegram?.configured && (
                            <button
                                type="button"
                                className="secondary secondary--danger"
                                onClick={handleTelegramDelete}
                                disabled={
                                    telegramDeleting ||
                                    telegramSaving ||
                                    telegramTesting
                                }
                            >
                                {telegramDeleting
                                    ? "Eliminando…"
                                    : "Eliminar integración"}
                            </button>
                        )}

                        {telegram?.last_sent_at && (
                            <p className="field__hint">
                                Último mensaje enviado:{" "}
                                {formatFullDate(telegram.last_sent_at)}
                            </p>
                        )}

                        {telegram?.last_checked_at && (
                            <p className="field__hint">
                                Última comprobación:{" "}
                                {formatFullDate(telegram.last_checked_at)}
                            </p>
                        )}

                        {telegram?.last_error && (
                            <p className="telegram-error">
                                Último error: {telegram.last_error}
                            </p>
                        )}
                    </form>
                )}
            </div>
        </details>
    );
}

function SenderFilter({ senders, selected, onChange }) {
    const detailsRef = useRef(null);
    const selectedSet = new Set(selected);

    useEffect(() => {
        function handleDocumentClick(event) {
            if (
                detailsRef.current &&
                !detailsRef.current.contains(event.target)
            ) {
                detailsRef.current.removeAttribute("open");
            }
        }

        function handleKeyDown(event) {
            if (event.key === "Escape" && detailsRef.current) {
                detailsRef.current.removeAttribute("open");
            }
        }

        document.addEventListener("click", handleDocumentClick);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("click", handleDocumentClick);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, []);

    function toggleSender(key) {
        onChange((current) =>
            current.includes(key)
                ? current.filter((item) => item !== key)
                : [...current, key],
        );
    }

    let label = "Todos";
    if (selected.length === 1) {
        const sender = senders.find((item) => item.key === selected[0]);
        label = sender ? titleCase(sender.name) : "1 remitente";
    } else if (selected.length > 1) {
        label = `${selected.length} remitentes`;
    }

    return (
        <details className="sender-filter" ref={detailsRef}>
            <summary
                className="sender-filter__trigger"
                aria-label={`Filtrar por remitente: ${label}`}
            >
                <span className="sender-filter__value">{label}</span>
                <span className="sender-filter__chevron" aria-hidden="true">
                    <ChevronDownIcon />
                </span>
            </summary>

            <div
                className="sender-filter__menu"
                role="group"
                aria-label="Seleccionar remitentes"
            >
                <div className="sender-filter__head">
                    <span>
                        {senders.length === 1
                            ? "1 remitente"
                            : `${senders.length} remitentes`}
                    </span>
                    <button
                        type="button"
                        className="sender-filter__clear"
                        onClick={() => onChange([])}
                        disabled={selected.length === 0}
                    >
                        Todos
                    </button>
                </div>

                {senders.length === 0 ? (
                    <p className="sender-filter__empty">
                        No hay remitentes disponibles.
                    </p>
                ) : (
                    <div className="sender-filter__list">
                        {senders.map((sender) => (
                            <label className="sender-option" key={sender.key}>
                                <input
                                    type="checkbox"
                                    checked={selectedSet.has(sender.key)}
                                    onChange={() => toggleSender(sender.key)}
                                />
                                <span className="sender-option__name">
                                    {titleCase(sender.name)}
                                </span>
                                <span className="sender-option__count">
                                    {sender.count}
                                </span>
                            </label>
                        ))}
                    </div>
                )}
            </div>
        </details>
    );
}

export default function Inbox({
    session,
    authStatus,
    onRefresh,
    refreshing,
    onLogout,
    onDeleteAccount,
    loggingOut,
    onUnauthorized,
    theme,
    onToggleTheme,
}) {
    const [messages, setMessages] = useState([]);
    const [children, setChildren] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshingInbox, setRefreshingInbox] = useState(false);
    const [error, setError] = useState(null);
    const [portalIssue, setPortalIssue] = useState(null);
    const [notice, setNotice] = useState(null);
    const [selectedUuid, setSelectedUuid] = useState(null);
    const [selectedChild, setSelectedChild] = useState("all");
    const [filter, setFilter] = useState("all");
    const [selectedSenders, setSelectedSenders] = useState([]);
    const [search, setSearch] = useState("");
    const [mobileDetail, setMobileDetail] = useState(false);
    const requestInFlight = useRef(false);

    const loadInbox = useCallback(
        async ({ silent = false } = {}) => {
            if (requestInFlight.current) {
                return;
            }

            requestInFlight.current = true;
            if (!silent) {
                setLoading(true);
            }

            try {
                const data = await getInbox();
                const nextMessages = Array.isArray(data.messages)
                    ? data.messages
                    : [];
                setMessages(nextMessages);
                setChildren(Array.isArray(data.children) ? data.children : []);
                setError(null);
                setPortalIssue(null);
                setNotice(null);
                setSelectedUuid((current) =>
                    nextMessages.some((message) => message.uuid === current)
                        ? current
                        : null,
                );
            } catch (requestError) {
                if (requestError.status === 401) {
                    onUnauthorized(requestError.message);
                    return;
                }
                if (requestError.source === "stilus") {
                    setPortalIssue({
                        status: requestError.status,
                        upstreamStatus: requestError.upstreamStatus,
                        message: requestError.message,
                    });
                } else {
                    setPortalIssue(null);
                }
                setError(requestError.message);
            } finally {
                requestInFlight.current = false;
                if (!silent) {
                    setLoading(false);
                }
            }
        },
        [onUnauthorized],
    );

    useEffect(() => {
        loadInbox();
    }, [loadInbox]);

    useEffect(() => {
        const interval = setInterval(
            () => loadInbox({ silent: true }),
            AUTO_REFRESH_MS,
        );

        function handleVisibilityChange() {
            if (document.visibilityState === "visible") {
                loadInbox({ silent: true });
            }
        }

        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            clearInterval(interval);
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
        };
    }, [loadInbox]);

    useEffect(() => {
        if (mobileDetail && window.matchMedia("(max-width: 980px)").matches) {
            window.scrollTo({ top: 0, behavior: "auto" });
        }
    }, [mobileDetail, selectedUuid]);

    const selected =
        messages.find((message) => message.uuid === selectedUuid) ?? null;
    const totalUnread = messages.filter((message) => !message.is_read).length;

    const childUnread = useMemo(() => {
        const counts = new Map();
        for (const child of children) {
            counts.set(child.matriculaId, 0);
        }
        for (const message of messages) {
            if (message.is_read) {
                continue;
            }
            for (const child of message.children) {
                if (counts.has(child.matriculaId)) {
                    counts.set(
                        child.matriculaId,
                        counts.get(child.matriculaId) + 1,
                    );
                }
            }
        }
        return counts;
    }, [children, messages]);

    const senderOptions = useMemo(() => {
        const senders = new Map();

        for (const message of messages) {
            const name = message.remitente?.nombreCompleto?.trim();
            if (!name) {
                continue;
            }

            const key = normalizeSenderName(name);
            const current = senders.get(key);

            if (current) {
                current.count += 1;
                if (!message.is_read) {
                    current.unread += 1;
                }
            } else {
                senders.set(key, {
                    key,
                    name,
                    count: 1,
                    unread: message.is_read ? 0 : 1,
                });
            }
        }

        return [...senders.values()].sort((first, second) =>
            first.name.localeCompare(second.name, "es"),
        );
    }, [messages]);

    useEffect(() => {
        setSelectedSenders((current) => {
            if (!current.length) {
                return current;
            }

            const available = new Set(
                senderOptions.map((sender) => sender.key),
            );
            const next = current.filter((key) => available.has(key));
            return next.length === current.length ? current : next;
        });
    }, [senderOptions]);

    const filteredMessages = useMemo(() => {
        const query = search.trim().toLocaleLowerCase("es");

        return messages.filter((message) => {
            if (filter === "unread" && message.is_read) {
                return false;
            }

            if (
                selectedChild !== "all" &&
                !message.children.some(
                    (child) => String(child.matriculaId) === selectedChild,
                )
            ) {
                return false;
            }

            if (
                selectedSenders.length > 0 &&
                !selectedSenders.includes(
                    normalizeSenderName(message.remitente?.nombreCompleto),
                )
            ) {
                return false;
            }

            if (!query) {
                return true;
            }

            const haystack = [
                message.asunto,
                message.texto,
                message.remitente?.nombreCompleto,
                message.tipoComunicacion?.descripcion,
                ...message.children.map((child) => child.nombreCompleto),
            ]
                .filter(Boolean)
                .join(" ")
                .toLocaleLowerCase("es");

            return haystack.includes(query);
        });
    }, [messages, filter, selectedChild, selectedSenders, search]);

    const markAsRead = useCallback(
        async (message) => {
            if (!message || message.is_read) {
                return true;
            }

            const matriculaIds = (message.children ?? []).map(
                (child) => child.matriculaId,
            );

            setMessages((current) =>
                current.map((item) =>
                    item.uuid === message.uuid
                        ? { ...item, is_read: true }
                        : item,
                ),
            );
            setNotice(null);

            try {
                const result = await markMessageRead(
                    message.uuid,
                    matriculaIds,
                );
                setMessages((current) =>
                    current.map((item) =>
                        item.uuid === message.uuid
                            ? {
                                  ...item,
                                  is_read: true,
                                  read_at: result.read_at ?? item.read_at,
                              }
                            : item,
                    ),
                );

                if (result.portal_updated === false) {
                    setNotice(
                        result.warning ??
                            "El estado se guardó en el servidor, pero no se pudo actualizar en Stilus.",
                    );
                }
                return true;
            } catch (requestError) {
                setMessages((current) =>
                    current.map((item) =>
                        item.uuid === message.uuid
                            ? { ...item, is_read: false }
                            : item,
                    ),
                );

                if (requestError.status === 401) {
                    onUnauthorized(requestError.message);
                    return false;
                }

                if (requestError.source === "stilus") {
                    setPortalIssue({
                        status: requestError.status,
                        upstreamStatus: requestError.upstreamStatus,
                        message: requestError.message,
                    });
                }

                setError(
                    `No se pudo marcar el mensaje como leído: ${requestError.message}`,
                );
                return false;
            }
        },
        [onUnauthorized],
    );

    function handleSelect(message) {
        setSelectedUuid(message.uuid);
        setMobileDetail(true);
        setNotice(null);

        if (!message.is_read) {
            void markAsRead(message);
        }
    }

    function handleChildChange(value) {
        setSelectedChild(value);
        setSelectedUuid(null);
        setMobileDetail(false);
    }

    async function handleManualRefresh() {
        if (refreshingInbox) {
            return;
        }

        setRefreshingInbox(true);
        await loadInbox({ silent: messages.length > 0 });
        setRefreshingInbox(false);
    }

    const hasMessages = messages.length > 0;
    const showErrorState = !loading && Boolean(error) && !hasMessages;
    const showSkeleton = loading && !hasMessages;

    return (
        <div className="inbox-page">
            <header className="inbox-topbar">
                <div className="inbox-brand">
                    <span className="brand brand--compact" aria-hidden="true">
                        S
                    </span>
                    <div>
                        <p className="eyebrow">Portal Stilus Familias</p>
                        <h1>Mensajes</h1>
                    </div>
                </div>

                <div className="inbox-topbar__actions">
                    <ThemeToggle theme={theme} onToggle={onToggleTheme} />

                    <span
                        className={`unread-pill ${
                            totalUnread ? "unread-pill--active" : ""
                        }`.trim()}
                    >
                        {totalUnread ? `${totalUnread} sin leer` : "Todo leído"}
                    </span>

                    <button
                        type="button"
                        className="ghost-button"
                        onClick={handleManualRefresh}
                        disabled={refreshingInbox}
                    >
                        <RefreshIcon />
                        {refreshingInbox ? "Actualizando…" : "Actualizar"}
                    </button>

                    <AccountMenu
                        session={session}
                        authStatus={authStatus}
                        onRefresh={onRefresh}
                        refreshing={refreshing}
                        onLogout={onLogout}
                        onDeleteAccount={onDeleteAccount}
                        loggingOut={loggingOut}
                    />
                </div>
            </header>

            <section className="inbox-toolbar" aria-label="Filtros de mensajes">
                <label className="search">
                    <SearchIcon />
                    <input
                        type="search"
                        placeholder="Buscar por asunto, remitente o texto…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </label>

                <div className="filter-block">
                    <span className="filter-label">Estado</span>
                    <div
                        className="filter-group"
                        role="group"
                        aria-label="Leídos"
                    >
                        <button
                            type="button"
                            className={`chip ${
                                filter === "all" ? "chip--active" : ""
                            }`.trim()}
                            onClick={() => setFilter("all")}
                        >
                            Todos
                        </button>
                        <button
                            type="button"
                            className={`chip ${
                                filter === "unread" ? "chip--active" : ""
                            }`.trim()}
                            onClick={() => setFilter("unread")}
                        >
                            No leídos
                        </button>
                    </div>
                </div>

                <div className="filter-block filter-block--sender">
                    <span className="filter-label">Remitente</span>
                    <SenderFilter
                        senders={senderOptions}
                        selected={selectedSenders}
                        onChange={setSelectedSenders}
                    />
                </div>

                <div className="filter-block filter-block--children">
                    <span className="filter-label">Hijo</span>
                    <div className="child-tabs" role="group" aria-label="Hijos">
                        <button
                            type="button"
                            className={`chip ${
                                selectedChild === "all" ? "chip--active" : ""
                            }`.trim()}
                            onClick={() => handleChildChange("all")}
                        >
                            Todos
                        </button>
                        {children.map((child) => {
                            const unread =
                                childUnread.get(child.matriculaId) ?? 0;
                            return (
                                <button
                                    type="button"
                                    className={`chip ${
                                        selectedChild ===
                                        String(child.matriculaId)
                                            ? "chip--active"
                                            : ""
                                    }`.trim()}
                                    key={child.matriculaId}
                                    onClick={() =>
                                        handleChildChange(
                                            String(child.matriculaId),
                                        )
                                    }
                                >
                                    {titleCase(child.nombre)}
                                    {unread > 0 && (
                                        <span className="chip__count">
                                            {unread}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </section>

            {notice && (
                <div
                    className="inbox-banner inbox-banner--warning"
                    role="status"
                >
                    <AlertIcon />
                    <span>{notice}</span>
                </div>
            )}

            {portalIssue && hasMessages && (
                <div
                    className="inbox-banner inbox-banner--upstream"
                    role="alert"
                >
                    <AlertIcon />
                    <div className="inbox-banner__content">
                        <strong>{portalIssueTitle(portalIssue)}</strong>
                        <span>
                            El fallo está en los servidores de Stilus, no en
                            esta aplicación. Tu sesión sigue siendo válida.
                            Vuelve a intentarlo en unos minutos.
                        </span>
                    </div>
                    <button
                        type="button"
                        className="banner-action"
                        onClick={handleManualRefresh}
                    >
                        Reintentar
                    </button>
                </div>
            )}

            {error && hasMessages && !portalIssue && (
                <div className="inbox-banner inbox-banner--error" role="alert">
                    <AlertIcon />
                    <span>{error}</span>
                    <button
                        type="button"
                        className="banner-action"
                        onClick={handleManualRefresh}
                    >
                        Reintentar
                    </button>
                </div>
            )}

            {showSkeleton && <InboxSkeleton />}

            {showErrorState && (
                <div
                    className={`inbox-error-state ${
                        portalIssue ? "inbox-error-state--upstream" : ""
                    }`.trim()}
                >
                    <AlertIcon />
                    <h2>
                        {portalIssue
                            ? portalIssueTitle(portalIssue)
                            : "No se pudieron cargar los mensajes"}
                    </h2>
                    <p>
                        {portalIssue
                            ? "El fallo está en los servidores de Stilus, no en esta aplicación. Tu sesión sigue siendo válida. Vuelve a intentarlo en unos minutos."
                            : error}
                    </p>
                    <button
                        type="button"
                        className="ghost-button"
                        onClick={handleManualRefresh}
                    >
                        Reintentar
                    </button>
                </div>
            )}

            {!showSkeleton && !showErrorState && (
                <div
                    className={`inbox-grid ${
                        mobileDetail ? "inbox-grid--detail" : ""
                    }`.trim()}
                >
                    <section
                        className={`message-list-panel ${
                            mobileDetail
                                ? "message-list-panel--hidden-mobile"
                                : ""
                        }`.trim()}
                        aria-label="Lista de mensajes"
                    >
                        {filteredMessages.length === 0 ? (
                            <div className="inbox-empty">
                                <InboxIcon />
                                <p>
                                    {search ||
                                    filter !== "all" ||
                                    selectedChild !== "all"
                                        ? "No hay mensajes que coincidan con el filtro."
                                        : "No hay mensajes."}
                                </p>
                            </div>
                        ) : (
                            <ul className="message-list">
                                {filteredMessages.map((message) => (
                                    <MessageItem
                                        key={message.uuid}
                                        message={message}
                                        selected={message.uuid === selectedUuid}
                                        onSelect={handleSelect}
                                    />
                                ))}
                            </ul>
                        )}
                    </section>

                    <section
                        className="message-detail-panel"
                        aria-live="polite"
                    >
                        {selected ? (
                            <MessageDetail
                                message={selected}
                                onBack={() => setMobileDetail(false)}
                                onMarkRead={markAsRead}
                            />
                        ) : (
                            <EmptyDetail />
                        )}
                    </section>
                </div>
            )}
        </div>
    );
}
