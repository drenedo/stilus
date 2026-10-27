# Stilus Server

Express 5 API and headless Telegram CLI for Stilus.

The server is responsible for:

- Authenticating against Stilus through `../get_token.py` and Selenium.
- Storing accounts, encrypted tokens, credentials, read state and Telegram
  state in SQLite.
- Issuing per-browser HttpOnly session cookies for multi-user access.
- Renewing each Stilus access token automatically when it expires.
- Fetching children and communications from the Stilus portal.
- Merging the family inbox, tracking read state and proxying attachments.
- Sending Telegram notifications for new messages, including attachments.
- Serving the built React frontend when `../frontend/dist` exists.
- Providing a headless CLI (`npm run telegram`) that runs without Express or the
  UI.

See [`../frontend/README.md`](../frontend/README.md) for the React UI.

## Requirements

- Node.js 20 or newer (Node 20 is used by the Docker image).
- Python 3.10 or newer.
- A Python virtual environment with the root `requirements.txt` installed.
- Firefox.
- `geckodriver`:
    - optional in `config.yaml`; if omitted, Selenium Manager locates or
      downloads it.
- The root-level `get_token.py` and `requirements.txt` files.

## Install

From the repository root:

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

cd server
npm install
```

The server validates the Python interpreter at startup and exits with
instructions if `PyYAML` or `Selenium` is missing.

Formatting and linting are configured at the repository root:

```bash
cd ..
npm install
npm run format
npm run lint
```

Prettier uses 4-space indentation for JavaScript, JSX, JSON, CSS, HTML and
Markdown. ESLint uses the flat config in `../eslint.config.js`. Python files are
ignored by Prettier; the existing Python code already uses 4-space indentation.

## Run

```bash
cd server
npm start
```

The API listens on <http://127.0.0.1:8000> by default. It serves
`frontend/dist` automatically when that directory exists.

Development mode with automatic restart:

```bash
npm run dev
```

Headless Telegram mode without Express or the frontend:

```bash
npm run telegram -- --help
```

## Scripts

| Script             | Description                                    |
| ------------------ | ---------------------------------------------- |
| `npm start`        | Starts the Express API and background pollers. |
| `npm run dev`      | Starts the API with `node --watch`.            |
| `npm run telegram` | Runs the headless Telegram CLI.                |

## Environment variables

### Server

| Variable            | Default                    | Description                                                                      |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `PORT`              | `8000`                     | HTTP port.                                                                       |
| `HOST`              | `127.0.0.1`                | Bind address. Keep localhost unless you really need remote access.               |
| `PYTHON`            | auto-detected              | Python executable. It is tried before `venv/.venv/env`, then `python3`/`python`. |
| `STILUS_CONFIG`     | `../config.yaml`           | Alternative YAML configuration path.                                             |
| `STILUS_DATA_DIR`   | repository root            | Directory for the SQLite database and `.session.key`. Used by Docker (`/data`).  |
| `COOKIE_SECURE`     | `false`                    | Set to `true` behind HTTPS to add the cookie `Secure` attribute.                 |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Telegram Bot API base URL. Useful for tests or a self-hosted Bot API.            |

### Headless CLI

| Variable             | Equivalent option       |
| -------------------- | ----------------------- |
| `TELEGRAM_BOT_TOKEN` | `--bot-token`           |
| `TELEGRAM_CHAT_ID`   | `--chat-id`             |
| `STILUS_USER`        | `--user` / `--username` |
| `STILUS_PASSWORD`    | `--password`            |

`STILUS_TELEGRAM_DAEMON` is an internal marker set by `--detach`; do not use it
manually.

## Structure

```text
server/
├── index.js           # Express API, accounts, portal, inbox, Telegram, pollers
├── db.js              # SQLite schema and account/session/read/Telegram state
├── telegram-cli.js    # Headless Telegram mode
├── package.json       # Scripts and dependencies
├── package-lock.json
├── README.md
└── node_modules/      # Installed dependencies (git-ignored)
```

Runtime files live in the repository root, not in `server/`. See
[Stored files](#stored-files).

## Startup and Python detection

`resolvePython()` tries candidates in this order:

1. `PYTHON` environment variable.
2. `venv/bin/python` (or `venv\Scripts\python.exe` on Windows).
3. `.venv/bin/python`.
4. `env/bin/python`.
5. `python3` and `python` from `PATH`.

Each candidate is checked with:

```python
import yaml, selenium
```

If none works, the server prints setup instructions and exits. The CLI imports
the same module, so it uses the same detection logic.

## Authentication and session

### Login flow

`POST /api/login` receives:

```json
{
    "username": "name@educa.jcyl.es",
    "password": "secret"
}
```

The server spawns:

```text
python get_token.py --config <config> --credentials-stdin
```

and writes the credentials as JSON to the child process's stdin. The password
is therefore not placed in process arguments or on disk in plaintext. The
server reads the last non-empty stdout line as the token.

Timeout: 120 seconds. The browser/API error mapping is:

| Condition                         | Status |
| --------------------------------- | ------ |
| `AuthenticationError` from ADFS   | `401`  |
| Portal timeout                    | `504`  |
| Missing Python dependencies       | `500`  |
| Missing geckodriver               | `500`  |
| Firefox/WebDriver failure         | `502`  |
| No `access_token` in the redirect | `502`  |
| Other unexpected error            | `500`  |

`get_token.py` opens Firefox headless through Selenium, fills the ADFS login
form and reads the token from the redirect URL fragment.

### Account and browser-session storage

After a successful login the server creates or updates a row in the `accounts`
table of `/data/stilus.sqlite` (or the repository root when `STILUS_DATA_DIR` is
not set). Sensitive fields are encrypted with AES-256-GCM:

- `username` and a lowercase `username_key` used for uniqueness and lookups.
- The encrypted access token and its `obtained_at` timestamp.
- The encrypted username/password used for automatic renewal.

Each browser also receives an `HttpOnly`, `SameSite=Lax` cookie named
`stilus_session`. The cookie contains 32 random bytes; SQLite stores only its
SHA-256 hash in `web_sessions`, along with the account and expiry. Web sessions
last 30 days. `COOKIE_SECURE=true` adds the `Secure` attribute when the UI is
served over HTTPS.

Other tables:

| Table               | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `accounts`          | One row per Stilus username, encrypted token/credentials.    |
| `web_sessions`      | Hashed browser-session identifiers, account and expiry.      |
| `read_state`        | Local read timestamps and enrolment IDs per account/message. |
| `telegram_settings` | Per-account chat ID, encrypted bot token, status.            |
| `telegram_notified` | Message UUIDs already sent, per account.                     |
| `telegram_locks`    | Per-account cross-process polling lock and expiry.           |

The encryption key is generated lazily in `.session.key` as 32 random bytes
(hex encoded) with mode `0600`. The SQLite file and key are protected with mode
`0600`; WAL/SHM files are created beside it. If `.session.key` is deleted, the
encrypted credentials cannot be decrypted. The server invalidates that account's
token, credentials and browser sessions; the user must log in again.

Different browsers can hold different cookies and therefore different Stilus
accounts. There is no single global session: every request resolves its account
from the cookie. Two browsers using the same Stilus username intentionally share
the account row, token, read state and Telegram settings.

### Token renewal

The server reads the JWT `exp` internally, but it does **not** renew before the
token expires and does **not** run a background renewal timer.

- Each account's stored token is used while it is valid.
- When `now >= exp`, the next portal request (or `GET /api/token`) logs in again
  with that account's stored credentials, stores the new token and continues.
- A portal `401` also triggers a renewal and one retry.
- `GET /api/token` returns the authenticated browser's current token and renews
  it only when already expired.
- `POST /api/token/refresh` forces a new login and token (the frontend's
  **Renovar token** action).
- Renewals are single-flight per account within each process: concurrent
  requests for the same account share one login attempt, while different
  accounts are serialized by the global Selenium queue. The optional CLI is a
  separate process, so avoid refreshing the same account from both at once.
- If the portal rejects the stored credentials (`401`), that account's token and
  credentials are cleared, its browser sessions are deleted, and its read state
  and Telegram settings are kept for the next successful login.
- Timeouts and transient portal failures do not invalidate the account; they are
  retried on a later request.

The server writes a console message when a token is renewed. It never logs the
token or password.

### Logout and account deletion

`POST /api/logout` deletes the current browser's `web_sessions` row and clears
the cookie. The account, encrypted credentials, read state and Telegram
configuration remain, so automatic renewal and Telegram notifications can
continue. Use `DELETE /api/telegram` to remove only the Telegram integration.

`DELETE /api/account` deletes the account row, all its browser sessions, read
state, Telegram settings, notified UUIDs and locks. The frontend asks for
confirmation before calling it.

## Stilus portal integration

The server talks directly to the Stilus backend:

```text
https://stilus.educa.jcyl.es/bkstfm
```

| Request                                                                                                       | Purpose                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `GET /matriculas/educacyl`                                                                                    | Children/enrolments visible to the account. |
| `GET /comunicaciones/{matriculaId}?clase=recibidas&archivada=false&offset=N&limit=80&sort=-fechaComunicacion` | Received communications for one child.      |
| `PATCH /comunicaciones/lecturas/{matriculaId}` with `{"uuids":["..."]}`                                       | Marks communications as read for one child. |
| `GET /adjuntos/{uuid}`                                                                                        | Downloads an attachment.                    |

All portal requests use `Authorization: Bearer <token>` and a 30-second
timeout. If the portal returns `401`, the server forces a token renewal and
retries the request once. Communications are paginated 80 at a time, up to 20
pages per child.

The web frontend only talks to the local API; the API and the headless CLI
perform the Stilus and Telegram requests themselves.

## Inbox

`GET /api/inbox`:

1. Ensures the session/token is valid.
2. Fetches the children from `/matriculas/educacyl`.
3. Fetches each child's received, non-archived communications concurrently.
4. Merges messages by `uuid`, so a message sent to two children appears once.
5. Merges children, recipients and attachments without duplicates.
6. Applies the logged-in account's local read state from SQLite (`read_state`).
7. Computes:

```json
{
    "status": "ok",
    "fetched_at": "ISO date",
    "children": [
        {
            "matriculaId": 234234234,
            "personaId": 23423423,
            "nombreCompleto": "JANE DOE",
            "nombre": "JANE",
            "curso": "Segundo Ciclo de Educación Infantil",
            "grupo": "I1A",
            "total": 24,
            "unread": 7
        }
    ],
    "messages": [
        {
            "uuid": "...",
            "asunto": "...",
            "remitente": {},
            "texto": "...",
            "fechaComunicacion": "2026-10-16T11:49:59",
            "tipoComunicacion": {},
            "tipoRespuesta": {},
            "adjuntos": [],
            "children": [],
            "destinatarios": [],
            "is_read": false,
            "read_at": null,
            "is_archived": false,
            "unread_children": [10034875]
        }
    ],
    "unread": 9
}
```

A message is considered read when it has a local read timestamp or every child
recipient has read it in Stilus.

## Read state

Read state is stored in SQLite, keyed by the lowercase account username and the
message UUID:

| Column          | Content                                                    |
| --------------- | ---------------------------------------------------------- |
| `username_key`  | Account identity (lowercase username).                     |
| `message_uuid`  | Stilus message UUID.                                       |
| `read_at`       | First local read timestamp.                                |
| `matricula_ids` | JSON array of enrolment IDs whose portal update was tried. |

`POST /api/inbox/:uuid/read`:

1. Requires a valid browser session and resolves its account.
2. Validates the UUID.
3. Requires `matricula_ids` in the JSON body.
4. Saves the local read state first, merging enrolment IDs.
5. Calls the Stilus read endpoint for each supplied enrolment.
6. Returns:

```json
{
    "status": "ok",
    "uuid": "...",
    "read_at": "ISO date",
    "portal_updated": true
}
```

If the local write succeeds but the portal update fails, the response still
returns `200` with `portal_updated: false` and a warning. This prevents the
message from reappearing as unread locally.

## Attachments

`GET /api/attachments/:uuid?name=<filename>`:

- Requires the browser's session cookie and resolves its account.
- Validates the UUID.
- Fetches the file from Stilus with that account's bearer token.
- Uses `name` only for the download filename; the value is sanitized.
- Sends `Content-Type`, `Content-Length`, `Content-Disposition` (ASCII fallback
  plus UTF-8 filename) and `Cache-Control: private, max-age=300`.
- Buffers the file in memory. Portal files are normally small PDFs and
  spreadsheets.

The Telegram sender uses the same portal download path, then uploads the file
to Telegram as a document.

## Telegram integration

### Configuration storage

Telegram settings are stored per account in SQLite (`telegram_settings`) and the
notified UUIDs in `telegram_notified`:

| Column            | Content                                                  |
| ----------------- | -------------------------------------------------------- |
| `username_key`    | Account identity (lowercase username).                   |
| `enabled`         | Whether notifications are enabled.                       |
| `chat_id`         | Destination chat or group ID.                            |
| `bot_token`       | AES-256-GCM JSON payload; never returned to the browser. |
| `bot_token_hint`  | Last four characters of the bot token.                   |
| `initialized`     | Whether the current inbox was baselined.                 |
| `last_checked_at` | Last poll time.                                          |
| `last_sent_at`    | Last successful Telegram send.                           |
| `last_error`      | Last polling error, if any.                              |

The bot token is encrypted with AES-256-GCM using `.session.key`. The API never
returns the token; it returns only the last four characters as a hint.

### Polling and delivery

The web server runs a Telegram poller every **5 minutes**, plus once at startup.
The headless CLI also polls its own account. For each target account:

1. Claims a per-account row in `telegram_locks` with a 60-minute expiry.
2. Loads the account, ensures its Stilus token is valid and decrypts the bot
   token.
3. Loads the inbox for that account.
4. On the first configured run (`initialized: false`), marks all current
   messages as notified without sending them.
5. For every message whose UUID is not in `telegram_notified`, oldest first:
    - Sends the subject, sender, children, date, type, text and attachment count.
    - Sends each attachment as a Telegram document.
    - Records the UUID and updates `last_sent_at`.
6. Records `last_checked_at` and `last_error`, then releases the lock.

Message text is split into chunks of up to 4000 characters. HTML entities are
decoded and the portal's link notation is converted to plain URLs. Attachment
failures are reported back to the chat with a warning, and the message is
still marked as notified to avoid duplicate text.

Telegram's bot upload limit is 50 MB per file. Larger files cannot be delivered
and are reported in the warning.

### Locking

`telegram_locks` has one row per account with the polling owner and an expiry.
A second process skips an account that is already being polled. Expired rows are
removed at the start of the next claim, so a crashed process cannot block
notifications indefinitely. The in-process `telegramPollInFlight` flag prevents
overlapping polls in one process.

### Baseline and downtime

- First configuration: current messages become `notified`; no history is sent.
- Messages that arrive while the server is stopped are sent on the next start
  because their UUIDs were never marked as notified.
- Read state does not affect Telegram delivery: a new message is notified even
  if it was already read elsewhere.

### Telegram endpoints

| Route                         | Purpose                                    |
| ----------------------------- | ------------------------------------------ |
| `GET /api/telegram`           | Current configuration without the token.   |
| `POST /api/telegram`          | Save bot token, chat ID and enabled state. |
| `POST /api/telegram/test`     | Send a test message.                       |
| `POST /api/telegram/discover` | Detect chats with `getUpdates`.            |
| `DELETE /api/telegram`        | Delete the user's Telegram configuration.  |

`POST /api/telegram` accepts:

```json
{
    "bot_token": "123456:ABC...",
    "chat_id": "123456789",
    "enabled": true
}
```

An empty `bot_token` keeps the stored token. Enabling requires a chat ID. The
first save baselines the current inbox.

## Headless Telegram CLI

The CLI starts no Express server and serves no UI. It imports the shared logic,
authenticates, stores/updates its account and Telegram configuration in SQLite,
and keeps polling until stopped. It polls only the account named in
`STILUS_USER`; the web server polls every enabled account.

### Usage

```bash
cd server

npm run telegram -- \
  --bot-token "123456:ABC..." \
  --user "name@educa.jcyl.es" \
  --password "secret"
```

If `--chat-id` is omitted, the CLI calls `getUpdates` and uses the most recent
chat. The bot must have received a message, usually `/start`.

### Options

| Option                  | Description                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `--bot-token <token>`   | Telegram bot token.                                           |
| `--chat-id <id>`        | Destination chat. Optional; detected when omitted.            |
| `--user <username>`     | Educa username.                                               |
| `--username <username>` | Alias for `--user`.                                           |
| `--password <secret>`   | Educa password.                                               |
| `--interval <minutes>`  | Poll interval in minutes. Default `5`; decimals are accepted. |
| `--detach`              | Spawn a detached background process and write the PID file.   |
| `--stop`                | Stop the process recorded in `telegram-cli.pid`.              |
| `--help`                | Show the English help text.                                   |

CLI terminal output and help are in English. The Telegram notification content
and the web UI remain in their existing format.

### Background mode

```bash
npm run telegram -- \
  --bot-token "..." \
  --user "..." \
  --password "..." \
  --detach
```

Files:

- `server/telegram-cli.log`: append-only log, mode `0600`.
- `server/telegram-cli.pid`: PID of the detached child, mode `0600`.

Stop it with:

```bash
npm run telegram -- --stop
```

The CLI and the web server share the SQLite database. Per-account database locks
prevent duplicate Telegram polls and serialize token refreshes for the same
account. Running both continuously is supported; the CLI is optional. In Docker,
use the `telegram` compose service instead of `--detach`; the container runs in
the foreground and Compose captures its logs.

### Environment variables

```bash
TELEGRAM_BOT_TOKEN="..." \
TELEGRAM_CHAT_ID="123456789" \
STILUS_USER="name@educa.jcyl.es" \
STILUS_PASSWORD="secret" \
npm run telegram -- --detach
```

Command-line arguments are visible in process listings on some systems. Use
environment variables or secure shell input when possible.

## API reference

All responses are JSON unless noted. Errors use:

```json
{ "detail": "Human-readable error." }
```

Failures coming from Stilus include two extra fields:

```json
{
    "detail": "El portal de Stilus no está disponible o devolvió un error 500. La sesión sigue siendo válida; inténtalo de nuevo más tarde.",
    "source": "stilus",
    "upstream_status": 500
}
```

The frontend uses `source` and `upstream_status` to show a specific notice that
the failure is in the Stilus backend, not in this application.

| Method   | Route                             | Body / query                    | Description                                  |
| -------- | --------------------------------- | ------------------------------- | -------------------------------------------- |
| `GET`    | `/api/health`                     | -                               | `{"status":"ok"}`.                           |
| `GET`    | `/api/token`                      | -                               | Return the current token; renew if expired.  |
| `POST`   | `/api/token/refresh`              | `{}`                            | Force a new login and token.                 |
| `POST`   | `/api/login`                      | `{username,password}`           | Authenticate and create the browser session. |
| `POST`   | `/api/logout`                     | `{}`                            | Close the current browser session.           |
| `DELETE` | `/api/account`                    | -                               | Delete the account and all its saved data.   |
| `GET`    | `/api/inbox`                      | -                               | Fetch and merge children/messages.           |
| `POST`   | `/api/inbox/:uuid/read`           | `{matricula_ids:[...]}`         | Mark a message read locally and in Stilus.   |
| `GET`    | `/api/attachments/:uuid?name=...` | -                               | Download an attachment (binary).             |
| `GET`    | `/api/telegram`                   | -                               | Telegram configuration without the token.    |
| `POST`   | `/api/telegram`                   | `{bot_token?,chat_id?,enabled}` | Save Telegram configuration.                 |
| `POST`   | `/api/telegram/test`              | `{bot_token?,chat_id?}`         | Send a test Telegram message.                |
| `POST`   | `/api/telegram/discover`          | `{bot_token?}`                  | Detect recent Telegram chats.                |
| `DELETE` | `/api/telegram`                   | -                               | Delete the Telegram configuration.           |

Most routes require the browser's `stilus_session` cookie. `/api/health` and
`/api/login` are public; `/api/logout` only clears the current cookie.
Authentication is tied to the Stilus account; there is no separate application
password. Use HTTPS and `COOKIE_SECURE=true` when the API is not restricted to
localhost.

All `POST` routes require `Content-Type: application/json`; otherwise the API
returns `415`. Body size is limited to 16 KB. Unknown `/api` routes return
`404`.

There is a global SPA fallback only for `GET` when `frontend/dist` exists; API
routes are matched first.

### Login/token response

`POST /api/login`, `GET /api/token` and `POST /api/token/refresh` return:

```json
{
    "status": "ok",
    "username": "name@educa.jcyl.es",
    "token": "...",
    "obtained_at": "2026-10-19T14:28:25.844Z",
    "renewed": false,
    "message": "Token actual.",
    "saved_to": "stilus.sqlite"
}
```

`obtained_at` is when the current token was generated. `renewed` is `true`
when the token was refreshed during the request. `saved_to` is only present on
login. The `message` text depends on the operation. The login response also sets
the `stilus_session` cookie.

### Telegram configuration response

`GET /api/telegram` and `POST /api/telegram` return the public configuration
without the bot token:

```json
{
    "status": "ok",
    "configured": true,
    "enabled": true,
    "chat_id": "123456789",
    "bot_token_hint": "abcd",
    "initialized": true,
    "last_checked_at": "2026-10-19T20:44:55.072Z",
    "last_sent_at": null,
    "last_error": null
}
```

`GET /api/telegram` for an account without configuration returns
`configured: false`, `enabled: false` and `null` values.

`POST /api/telegram/test` returns:

```json
{
    "status": "ok",
    "message": "Mensaje de prueba enviado a Telegram."
}
```

`POST /api/telegram/discover` additionally returns a `chats` array:

```json
{
    "status": "ok",
    "chats": [
        { "id": "123456789", "name": "Test User", "username": "testuser" }
    ],
    "message": "Chat detectado."
}
```

## Error handling

| Status | Typical cause                                                      |
| ------ | ------------------------------------------------------------------ |
| `400`  | Invalid UUID or malformed JSON body.                               |
| `401`  | No stored session, invalid credentials, or invalid portal session. |
| `415`  | Missing `Content-Type: application/json` on a POST.                |
| `422`  | Missing/invalid fields or missing Telegram chat ID.                |
| `500`  | Missing Python dependencies, unexpected server error.              |
| `502`  | Stilus or Telegram error, attachment download failure.             |
| `504`  | Portal or login timeout.                                           |

## Stored files

These files live in the repository root unless noted. They are all git-ignored.
When `STILUS_DATA_DIR` is set, they live under that directory instead. The
Docker compose file uses the named volume `stilus-data` mounted at `/data`.

| Path                      | Mode   | Purpose                                                         |
| ------------------------- | ------ | --------------------------------------------------------------- |
| `stilus.sqlite`           | `0600` | Accounts, hashed web sessions, read state and Telegram state.   |
| `stilus.sqlite-wal`       | `0600` | SQLite write-ahead log while the server is running.             |
| `stilus.sqlite-shm`       | `0600` | SQLite shared-memory file while the server is running.          |
| `.session.key`            | `0600` | AES-256-GCM key used for tokens, credentials and bot tokens.    |
| `server/telegram-cli.log` | `0600` | Detached CLI log (host mode only).                              |
| `server/telegram-cli.pid` | `0600` | Detached CLI PID (host mode only).                              |
| `config.yaml`             | user   | Optional YAML configuration for `get_token.py`/`get_alerts.py`. |

`session.json`, `read-state.json`, `telegram.json` and `telegram.lock` from older
versions are imported into SQLite and removed automatically on startup. If
`session.json` cannot be read, it is left in place for recovery; the migration
does not overwrite an existing account row.

`config.yaml` may contain a plaintext password in its `user` block for the
command-line scripts. Keep it out of Git. The web server and headless CLI take
credentials from the form/CLI and store them encrypted in SQLite.

### Docker

The root `Dockerfile` and `compose.yaml` build a single image with the server,
the compiled frontend, Python/Selenium, Firefox and geckodriver. The `web`
profile serves the API and UI; the `telegram` profile runs only
`telegram-cli.js`. Inside the container:

```text
STILUS_DATA_DIR=/data
STILUS_CONFIG=/app/config.docker.yaml
PYTHON=/opt/venv/bin/python
```

Use the compose `telegram` service instead of `--detach` inside the container;
Compose manages the process in the foreground and captures its stdout. See the
root README for the exact commands, profiles, volume and environment variables.

## Security notes

- The API binds to `127.0.0.1` by default. Do not expose it to an untrusted
  network without HTTPS and a reverse proxy. Set `COOKIE_SECURE=true` when HTTPS
  is in use.
- Credentials, Stilus tokens and the Telegram bot token are encrypted at rest
  with AES-256-GCM. Anyone who can read both the SQLite database and
  `.session.key` with your OS account can decrypt them. For stronger isolation,
  use full-disk encryption or a secrets manager.
- Browser sessions are opaque random cookies (`HttpOnly`, `SameSite=Lax`); only
  SHA-256 hashes are stored in SQLite. Web sessions expire after 30 days.
- The Stilus password is sent to Python through stdin in the web flow, not in
  process arguments. CLI arguments are visible to local process listings;
  prefer environment variables.
- The Stilus token is returned by `/api/token` only to an authenticated browser
  session; the web UI does not display or store it. The Telegram bot token is
  never returned; only its last four characters are shown.
- Portal and Telegram requests use HTTPS by default.
- `config.yaml`, the database, the key and legacy session files are listed in
  `.gitignore`.

## Limitations

- One row per Stilus username, but multiple independent accounts and browser
  sessions are supported. Two browsers using the same account share its token,
  read state and Telegram settings.
- Polling only. Stilus does not provide webhooks in this implementation.
- Only received, non-archived communications are fetched.
- The inbox does not send replies, archive messages or upload attachments.
- Telegram notifications are one-way; the bot does not expose an interactive
  inbox or commands.
- Telegram attachments are limited by the Bot API (50 MB per document).
- There is no separate test suite yet; Prettier and ESLint are configured.
- Portal endpoints and response shapes may change without notice.
- The web server and headless CLI can run together, and SQLite locks prevent
  duplicate Telegram polls. Token refreshes are single-flight per process only;
  if both poll the same account, a simultaneous refresh can race, so the web
  profile alone is recommended.

## Troubleshooting

| Problem                                                        | Check                                                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `No se encontró un intérprete de Python con PyYAML y Selenium` | Create `venv` and install the root `requirements.txt`; or set `PYTHON`.                                                                   |
| `ModuleNotFoundError: yaml` / `selenium`                       | The selected Python is not the venv; restart with `PYTHON=/path/to/venv/bin/python`.                                                      |
| Login fails with `401`                                         | Wrong Educa credentials. The stored session was removed if this happened during a token renewal.                                          |
| Login times out (`504`)                                        | Portal/network issue; the session is kept and retried.                                                                                    |
| `Geckodriver not found`                                        | Point `geckodriver` in `config.yaml` to a valid binary, or remove it and let Selenium Manager resolve it.                                 |
| Firefox does not start                                         | Install Firefox or check the geckodriver/Firefox version compatibility.                                                                   |
| `415` on a POST                                                | Send `Content-Type: application/json`.                                                                                                    |
| `401` from `/api/token`                                        | No session or invalid session; log in again.                                                                                              |
| `/api/inbox` returns `502/504`                                 | Portal error or timeout; retry. A `401` triggers a forced login and one retry.                                                            |
| Telegram test fails                                            | Check bot token and chat ID. The user must press `/start` in the bot first.                                                               |
| Telegram `getUpdates` fails                                    | A webhook may be configured for the bot; remove it or enter the chat ID manually.                                                         |
| Telegram messages are not sent                                 | Check the account's Telegram settings and `last_error`; the web server must be running and the account must still have valid credentials. |
| Attachments return `502`                                       | Portal attachment unavailable or session rejected. Retry after a token renewal.                                                           |
| Port 8000 is already in use                                    | Stop the other process or set `PORT`.                                                                                                     |
| Telegram poll returns immediately                              | Another process holds that account's row in `telegram_locks`; wait for the 60-minute expiry or stop the other poller.                     |
| `--stop` says no process                                       | The CLI was running in the foreground or the PID file was removed.                                                                        |
| Session cannot be decrypted                                    | `.session.key` was deleted/changed. Log in again and re-enter the Telegram bot token.                                                     |
| Frontend at `/` returns JSON                                   | `frontend/dist` does not exist; run `npm run build` in `frontend/`.                                                                       |

## Development notes

- Syntax check:
    ```bash
    node --check index.js
    node --check telegram-cli.js
    ```
- The Express app is only started when `index.js` is the process entry point.
  Importing it from `telegram-cli.js` defines the shared functions but does not
  listen on a port.
- The server uses native `fetch`, `FormData`, `Blob` and `AbortSignal.timeout`.
  Keep Node at 18+.
- Background intervals are unref'ed in the web server; the CLI keeps its own
  interval referenced so the process stays alive.
- After code changes, restart the API. Use `npm run dev` during development.
- Tests used during development mocked the Telegram Bot API with
  `TELEGRAM_API_BASE`; no real Telegram messages are required for local checks.
