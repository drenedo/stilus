# Stilus Frontend

React 18 + Vite interface for Stilus. It provides:

- A login screen for Educa credentials.
- A multi-user session view with per-browser cookies, token generation time,
  on-demand renewal, logout and account deletion.
- A family inbox with search, sender selection, child filters and unread state.
- Message detail with Markdown, attachments and automatic read marking.
- A Telegram configuration tab inside the account menu.
- Light and dark themes with system-preference detection and a visible switch.

The UI text is in Spanish. Code, configuration and these docs are in English.

## Requirements

- Node.js 20 or newer (the repository tooling uses Node 20).
- A running Stilus API. By default the frontend expects it at
  `http://127.0.0.1:8000`.
- A modern browser with support for `fetch`, `AbortController`,
  `Intl.DateTimeFormat`, `navigator.clipboard` and CSS `backdrop-filter`.
- Firefox, Selenium, and the Python environment required by the API are only
  needed on the server side.

## Install

```bash
cd frontend
npm install
```

Formatting and linting are configured at the repository root:

```bash
cd ..
npm install
npm run format
npm run lint
```

Prettier uses 4-space indentation. See the root `package.json` for the
available `format`, `format:check`, `lint` and `lint:fix` scripts.

## Run

Development server:

```bash
npm run dev
```

Open <http://localhost:5173>.

`vite.config.js` proxies `/api` to `http://127.0.0.1:8000`. If the API uses a
different port, update `server.proxy["/api"].target`.

Production build:

```bash
npm run build
```

The build is written to `frontend/dist`. The Express API serves that directory
automatically when it exists, so after restarting the server the complete app is
available at <http://127.0.0.1:8000>.

### Docker

The repository root includes `Dockerfile` and `compose.yaml`. The `web` compose
profile builds this frontend and serves the compiled `dist/` through Express:

```bash
docker compose --profile web up -d --build
```

Open <http://127.0.0.1:8000>. The host Vite server remains the development
workflow; Docker is the packaged/production workflow. See the root README for
profiles, the Telegram CLI service and data volumes.

`npm run preview` serves the build statically on port 4173. It uses the same
`/api` proxy target as the dev server, so it is another option for previewing
the production bundle. The Express server on port 8000 remains the complete
production setup.

## Scripts

| Script            | Description                                        |
| ----------------- | -------------------------------------------------- |
| `npm run dev`     | Starts Vite on port 5173 with the API proxy.       |
| `npm run build`   | Creates the production bundle in `dist/`.          |
| `npm run preview` | Serves `dist/` on port 4173 with the `/api` proxy. |

## Structure

```text
frontend/
├── index.html              # HTML shell, metadata and theme bootstrap script
├── package.json            # Dependencies and scripts
├── vite.config.js          # React plugin and /api proxy
└── src/
    ├── main.jsx            # React entry point
    ├── App.jsx             # Session/theme state, login, polling and view switch
    ├── LoginScreen.jsx     # Login form and initial session check
    ├── Inbox.jsx           # Inbox, detail, attachments and account menu
    ├── ThemeToggle.jsx     # Sun/moon light-dark switch
    ├── StatusAlert.jsx     # Shared success/error alert
    ├── icons.jsx           # Inline SVG icons
    ├── api.js              # API client and error wrapper
    ├── styles.css          # Global theme, light overrides and login styles
    └── inbox.css           # Inbox, account, Telegram and light overrides
```

## How it works

### Session and authentication

`App.jsx` owns the session state:

```js
{
  username: "name@educa.jcyl.es",
  obtained_at: "2026-10-20T07:28:25.844Z"
}
```

On first load:

1. `GET /api/token` is called.
2. If it returns a session, the inbox is shown.
3. If it returns `401`, the login screen is shown.
4. Any other error is shown on the login screen.

The login form calls `POST /api/login` with the username and password. On
success the server creates a SQLite-backed browser session and sets an
`HttpOnly`, `SameSite=Lax` cookie (`stilus_session`). React stores only the
username and token generation time; the password and token never enter browser
storage. Every fetch uses `credentials: "same-origin"`, so the cookie follows
same-origin requests through the Vite proxy or the Express server.

Different browsers can log in with different Stilus accounts at the same time:
each browser presents its own cookie, and the server resolves the matching
account. Opening a different account in the same browser replaces that browser's
cookie but does not delete the previous account from SQLite.

While a session exists, `App.jsx` calls `GET /api/token` every **5 minutes**
and when the tab becomes visible again. This keeps the session state and
generation time in sync. The server does not renew on a timer: it uses the
token while its `exp` is valid, and renews only after it has actually expired
or when Stilus rejects it. A `401` clears the local session and returns to the
login screen.

Logout calls `POST /api/logout`, which deletes the current browser session and
clears the cookie. The account and its encrypted credentials remain so token
renewal and Telegram notifications can continue. The account menu also offers
**Eliminar cuenta y datos guardados**, which calls `DELETE /api/account` after a
confirmation and removes the account, read state and Telegram settings.

### Inbox

`Inbox.jsx` calls `GET /api/inbox`:

- on mount,
- every **10 minutes**,
- when the tab becomes visible,
- when **Actualizar** is pressed.

This is polling, not push. There is no WebSocket or SSE connection. Only one
inbox request runs at a time. The server merges duplicate communications from
all children, so the UI receives a single list.

The UI filters and searches in memory:

- **Estado**: all messages or unread only.
- **Remitente**: multi-select dropdown grouped by sender, with a message count
  per sender. Selecting several senders shows messages from any of them.
- **Hijo**: all children or a specific child.
- **Search**: subject, sender, body and child names.

Selecting an unread message immediately:

1. Marks it as read in the local list (optimistic update).
2. Calls `POST /api/inbox/:uuid/read` with the message's `matricula_ids`.
3. Keeps the state if the server saves it.
4. Reverts to unread and shows an error if the request fails.

The server persists read state per Stilus account in SQLite (`read_state`) and
also tries to mark the message as read in Stilus. If the portal update fails but
the local state was saved, the UI shows a warning notice.

If Stilus returns a `5xx` response while loading the inbox, the UI shows a
specific upstream-outage warning instead of a generic error. It states that the
failure is on the Stilus side and that the session remains valid, and offers a
retry button.

Messages are rendered with `react-markdown` and `remark-gfm`. Links open in a
new tab; raw HTML is not rendered. The message body supports common Markdown
(bold, lists, links and paragraphs).

### Attachments

Attachments come from Stilus through the API:

```text
GET /api/attachments/:uuid?name=<filename>
```

The browser only talks to the local API; the server adds the Stilus bearer
token and streams the file with its original name and MIME type.

The message list shows a paperclip count when a message has attachments. In the
detail view, files are listed above the message body and can be downloaded
individually. **Descargar todo** triggers one download per file; browsers may
ask for permission to allow multiple downloads.

### Account menu and Telegram

The account dropdown has two tabs:

- **Cuenta**: session generation time, token renewal, logout and account
  deletion.
- **Telegram**: bot configuration.

The `Cuenta` tab shows when the current token was generated. The token itself
is not displayed; it stays server-side. The account menu explains that the
account stays saved for automatic renewal and Telegram notifications. **Cerrar
sesión** ends only this browser; **Eliminar cuenta y datos guardados** removes
the account and all its server-side state after confirmation.

The Telegram tab lets the user:

- Paste a bot token. Leaving the field empty keeps the stored token.
- Enter a chat ID or press **Detectar** to call Telegram `getUpdates`.
- Enable or disable notifications.
- Save the configuration.
- Send a test message.
- Delete the stored integration.

The server never returns the bot token to the browser; it only returns a hint
with the last four characters. Once the Telegram tab has loaded the
configuration, a small dot on the tab indicates that notifications are enabled.

The Telegram integration itself runs on the server. The frontend only manages
its configuration. See [`../server/README.md`](../server/README.md) for polling,
encryption, delivery details and the headless CLI.

### Polling summary

| Data              | Interval   | Other triggers                              |
| ----------------- | ---------- | ------------------------------------------- |
| Session state     | 5 minutes  | Tab becomes visible.                        |
| Inbox messages    | 10 minutes | Mount, tab becomes visible, **Actualizar**. |
| Telegram delivery | 5 minutes  | Server-side, independent of the UI.         |

## API client

`src/api.js` contains:

- `request(url, options)`: `fetch` wrapper with a 130-second timeout, JSON body
  parsing and a custom `ApiError` that exposes `status`.
- `login`, `getToken`, `refreshToken`, `logout`.
- `deleteAccount`, `getInbox`, `markMessageRead`.
- `getTelegramConfig`, `saveTelegramConfig`, `testTelegramConnection`,
  `discoverTelegramChat`, `deleteTelegramConfig`.

All calls use same-origin `/api` URLs, which works with the Vite proxy and with
the Express-served build. Requests use `credentials: "same-origin"` so the
server's `HttpOnly` session cookie is sent automatically.

## Styling

- `styles.css` defines the dark and light theme variables, background, shared
  buttons, alerts, the login card and the theme switch.
- `inbox.css` defines the inbox layout, message list/detail, attachments,
  responsive behavior, account/Telegram controls and their light overrides.
- The layout switches to a single column below 980px. On mobile, selecting a
  message hides the list, shows the detail and provides a **Volver** button.
- Reduced-motion preferences are respected.

### Themes

The initial theme is read from `localStorage["stilus.theme"]`. If no manual
choice exists, the app follows `prefers-color-scheme`. The sun/moon switch is
visible in the login card and in the inbox top bar. Toggling it stores `light`
or `dark` locally; while there is no manual choice, system changes are followed
live.

The theme is applied through `data-theme` on `<html>`, the CSS `color-scheme`
property and the `theme-color` meta tag. An inline bootstrap script in
`index.html` applies the theme before React loads, avoiding a flash of the
wrong theme. Light styles are scoped under `:root[data-theme="light"]` in both
CSS files. Remove the `stilus.theme` key or clear the site data to return to
following the browser preference.

## Security notes

- The frontend does not retain or display the Stilus token; token handling
  stays server-side. The only browser-persisted setting is the theme preference
  (`stilus.theme`).
- Credentials are sent only to the local API; they are not stored in the
  browser.
- The bot token is stored encrypted by the server and is not returned to the
  browser.
- The API binds to `127.0.0.1` by default and allows CORS only from the local
  Vite origins.
- The UI renders Markdown without raw HTML.

## Troubleshooting

| Problem                               | Check                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| "No se pudo conectar con el servidor" | The API is not running or the Vite proxy target is wrong.                                                  |
| The app returns to the login screen   | The server session was rejected or removed. Log in again.                                                  |
| Attachments return 404                | The running server is older than the attachment route. Restart it.                                         |
| Telegram **Detectar** finds no chat   | Open the bot in Telegram, send `/start`, then try again. A webhook on the bot can also block `getUpdates`. |
| Multiple downloads are blocked        | Allow multiple downloads in the browser or click files individually.                                       |
| Built UI is stale                     | Run `npm run build` again and restart the Express server.                                                  |
| API uses another port                 | Update `vite.config.js` and restart Vite.                                                                  |

## Development notes

- There is no router; `App.jsx` switches between login and inbox based on the
  session.
- React StrictMode is enabled.
- No test runner or linter is configured. Run `npm run build` after changes.
- Keep UI strings in Spanish, but keep code identifiers, comments and docs in
  English.
