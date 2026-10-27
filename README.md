# Stilus

Fetch communications from the
[Stilus](https://stilus.educa.jcyl.es/) portal.

## How to run

There are two supported ways to use the project:

| Option                  | Host requirements                                               | Recommended for                                   |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| **Docker**              | Docker Engine/Desktop 24+ with Docker Compose v2. Nothing else. | Normal use and servers.                           |
| **Manual installation** | Python 3.10+, Node.js 20+, Firefox and geckodriver.             | Development or modifying the code without Docker. |

### Option A — Docker (recommended)

**With Docker you do not need to install Python, Node.js, Firefox, geckodriver,
npm, pip or a virtual environment on the host.** The image builds and contains
all of them. Docker only needs to be able to download the image/build
dependencies the first time.

Start the web UI and the API together in one container:

```bash
docker compose --profile web up -d --build
```

Open <http://127.0.0.1:8000>.

- The `web` profile runs Express, the compiled React frontend, Python/Selenium,
  Firefox and geckodriver in a single container.
- `.env` is optional for the web profile. Create it if you need custom ports,
  LAN access or Telegram.
- If port 8000 is already in use, set `STILUS_WEB_PORT` in `.env` (for example
  `18000`).

For the Telegram-only profile, create `.env` from the example, fill the
Telegram/Educa values and run:

```bash
cp .env.example .env
# Edit .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, STILUS_USER, STILUS_PASSWORD
docker compose --profile telegram up -d --build
docker compose --profile telegram logs -f telegram
```

To run the web UI, API and Telegram CLI at the same time:

```bash
docker compose --profile web --profile telegram up -d --build
```

> **Multi-user:** each browser gets its own HttpOnly session cookie and can log
> in with a different Stilus account. Accounts, encrypted tokens and Telegram
> state live in SQLite. The web server and the optional Telegram CLI use
> per-account database locks to avoid duplicate notifications. Both profiles may
> run with a warning: a simultaneous token refresh for the same account can
> still race, so the web profile alone is recommended.

Docker state is stored in SQLite inside the named volume `stilus-data`. The old
`session.json`, `read-state.json` and `telegram.json` files are imported and
removed automatically the first time the new version starts. `docker compose
down` keeps the volume, while `docker compose down -v` deletes it.

See the [Docker reference](#docker-reference) for the environment variables,
volume details, architectures, commands and troubleshooting.

### Option B — Manual installation

Use this option if you want to run or modify the project without Docker. The
host must provide Python, Node.js, Firefox and geckodriver.

Quick start:

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

cd server
npm install
cd ../frontend
npm install
cd ..

cd server
npm start
```

In another terminal:

```bash
cd frontend
npm run dev
```

Open <http://localhost:5173>.

See [Manual installation](#manual-installation) for requirements,
configuration, command-line usage, production builds and tooling.

## Documentation

- [Server documentation](server/README.md) — Express API, sessions, inbox,
  attachments, Telegram delivery and the headless CLI.
- [Frontend documentation](frontend/README.md) — React UI, login, inbox,
  light/dark themes, polling, account menu and Telegram settings.

## Manual installation

### Requirements

- Python 3.10 or newer (the code uses `X | Y` type unions).
- Node.js 20 or newer for the Express API and tooling.
- Firefox.
- `geckodriver` — optional in `config.yaml`; if omitted, Selenium Manager
  locates or downloads it.
- The root-level `get_token.py` and `requirements.txt` files.

Docker users do not need any of these on the host. See
[Option A](#option-a--docker-recommended).

### Python environment

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

### Node dependencies

```bash
cd server
npm install

cd ../frontend
npm install

cd ..
```

The root `npm install` is only for the development tooling (Prettier/ESLint);
it is not needed to run the application.

### Configuration

Create a `config.yaml` file next to the scripts. It is only required for the
command-line scripts; the web login works with the defaults below:

```yaml
url: https://stilus.educa.jcyl.es/ftstfm/
geckodriver: /snap/bin/firefox.geckodriver

user:
    name: "nombre.apellido@educa.jcyl.es"
    password: "your-password"

children:
    - 10000001
    - 10000002
```

| Key             | Description                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`           | Portal entry point. Visiting it triggers the sign-in redirect that carries the access token. Defaults to `https://stilus.educa.jcyl.es/ftstfm/`. |
| `geckodriver`   | Absolute path to the `geckodriver` binary. If omitted, Selenium Manager locates or downloads it automatically.                                   |
| `user.name`     | Your `@educa.jcyl.es` account.                                                                                                                   |
| `user.password` | Password for that account.                                                                                                                       |
| `children`      | Student ids whose communications are fetched. One request is made per id.                                                                        |

The `children` ids are the portal's internal student identifiers, not the
student's name or document number. You can read them off the portal URL when
you select a child in the web interface.

If you set the `user` block, `config.yaml` holds a plaintext password and is
listed in `.gitignore`. Keep it that way — do not commit it.

### Run the API

```bash
cd server
npm start
```

The API listens on <http://127.0.0.1:8000> by default. It uses
`venv/bin/python` if the virtual environment exists; override it with
`PYTHON=/path/to/python npm start`. A different configuration file can be
selected with `STILUS_CONFIG`, the port with `PORT`, and the bind address with
`HOST`.

### Run the frontend in development

```bash
cd frontend
npm run dev
```

Open <http://localhost:5173>. The Vite proxy forwards `/api` requests to
Express. `config.yaml` is optional for the web login: the default portal URL is
`https://stilus.educa.jcyl.es/ftstfm/` and Selenium Manager obtains geckodriver
automatically. The `user` block is still used by the command-line scripts. The
interface follows the browser's light/dark preference and includes a visible
theme switch in the login card and inbox top bar.

### Production build without Docker

```bash
cd frontend
npm run build
```

Express serves `frontend/dist` automatically when it exists, so
<http://127.0.0.1:8000> works without the Vite server after restarting the API.

### Command-line scripts

```bash
./venv/bin/python get_alerts.py
```

Both scripts accept `--config` to point at a configuration file elsewhere:

```bash
./venv/bin/python get_alerts.py --config /path/to/other.yaml
```

### Tooling

Prettier and ESLint are configured at the repository root and cover the
`frontend/` and `server/` JavaScript, JSX, CSS, JSON, HTML and Markdown files.
The code style uses 4-space indentation.

```bash
npm install        # installs Prettier/ESLint at the root
npm run format     # format the project with Prettier
npm run format:check
npm run lint       # ESLint over frontend and server
npm run lint:fix
```

Python files are ignored by Prettier; the existing Python code already uses
4-space indentation. `.editorconfig` and `.prettierrc.json` both define the
4-space style. ESLint is kept on the 9.x line because `eslint-plugin-react`
currently declares support up to ESLint 9.

## Web login, multi-session and token renewal

The React frontend provides a login form that runs `get_token.py` through the
Express API. After a successful login the API stores an account record in
SQLite (`stilus.sqlite`, git-ignored):

- One row per Stilus username, with the access token, its generation time and
  the credentials encrypted with AES-256-GCM.
- Web sessions bound to the browser through an `HttpOnly`, `SameSite=Lax`
  cookie (`stilus_session`). The cookie contains a random identifier; only its
  SHA-256 hash is stored in SQLite.

The encryption key is generated locally in `.session.key` (mode `0600`,
git-ignored). The database file and its WAL files use mode `0600` when possible,
and the data directory uses `0700`.

Different browsers can be logged in with different Stilus accounts at the same
time. Requests are resolved through each browser's cookie, so one user's inbox,
read state and Telegram configuration never overwrite another user's data. Two
browsers using the same Stilus account share that account's token, read state
and Telegram configuration, which is the expected behaviour for the same
account on two devices.

The server uses the stored token while its JWT `exp` is in the future. It reads
`exp` internally only to detect actual expiry; it does **not** renew early and
does **not** run a background renewal timer. When `exp` has passed, the next
request to Stilus renews the token once with the stored credentials and
continues. A portal `401` triggers the same renewal. Renewals are single-flight
per account. If the portal rejects the stored credentials, that account's token,
credentials and browser sessions are invalidated while its read state and
Telegram configuration remain in SQLite; the login form is shown again.

"Renovar token" in the account menu forces a new login. "Cerrar sesión" removes
only the current browser cookie and session, so the account can keep renewing
and sending Telegram notifications. "Eliminar cuenta y datos guardados" deletes
the account, its sessions, read state and Telegram configuration.

The API exposes `GET /api/token` so authenticated browser tools can obtain the
current account token without running Selenium. It renews only if the stored
token is already expired. `POST /api/token/refresh` forces a new login and
token, `POST /api/logout` closes the browser session, and `DELETE /api/account`
deletes the account and its saved data.

The password is sent to `get_token.py` through stdin and never placed in process
arguments.

> `stilus.sqlite`, `.session.key` and the old JSON files live on this machine.
> Anyone with access to your user account and these files can decrypt the
> password and bot token, so protect your account and do not commit them. For
> stronger isolation, use full-disk encryption or a secrets manager.

## Inbox

When a session is active, the frontend shows the family inbox:

- It fetches the children from `GET /matriculas/educacyl` and their received
  communications from `GET /comunicaciones/{matriculaId}`.
- Messages shared by several children are merged into a single entry.
- You can search by subject, sender or text, filter unread messages, filter by
  child and select one or more grouped senders in a multi-select dropdown.
- Opening an unread message marks it as read in Stilus and stores the state in
  SQLite (`read_state`), keyed by the logged-in Stilus account and message UUID.
- Messages with attachments show a paperclip counter; attachments are listed
  before the message body and can be downloaded individually or all at once.
- If Stilus returns a `5xx` error, the inbox shows a specific warning stating
  that the failure is upstream and that the session is still valid, with a retry
  button.
- The inbox refreshes every 10 minutes and when the tab becomes visible again.

The inbox routes are:

| Route                                 | Description                                                  |
| ------------------------------------- | ------------------------------------------------------------ |
| `GET /api/inbox`                      | Fetches and merges the children's communications.            |
| `POST /api/inbox/:uuid/read`          | Marks a message read. Body: `{"matricula_ids": [10038875]}`. |
| `GET /api/attachments/:uuid?name=...` | Downloads an attachment using the stored token.              |

The local read state is kept even if Stilus cannot be updated, so the message
does not reappear as unread in this UI.

## Telegram notifications

You can configure a Telegram bot from the account menu (top right) →
**Telegram**:

1. Create a bot with `@BotFather` and copy its token.
2. Open the bot in Telegram and send `/start`.
3. Paste the token, click **Detectar** to obtain the chat ID, enable
   notifications and save.

The bot token is encrypted with AES-256-GCM and stored in SQLite
(`telegram_settings`), together with the per-account notified-message list. It
is never sent back to the browser; only its last four characters are shown as a
hint.

Once configured, the server checks all accounts with Telegram enabled every 5
minutes, independently of whether the web UI is open. Each new message is sent
to the configured chat with its subject, sender, children, date, type and full
text. Attachments are downloaded from Stilus and sent as Telegram documents. The
**Probar** button sends a test message, and **Eliminar integración** removes the
stored token and stops notifications for that account.

On the first configuration, the current messages are marked as already
notified, so only messages received after that moment are sent. If the server is
stopped, messages that arrived while it was down are sent on the next start.
Attachments larger than Telegram's bot upload limit cannot be sent; the bot
sends a warning listing them.

The integration is notification-only: the bot sends new messages but does not
expose an interactive inbox or accept commands.

Telegram routes:

| Route                         | Description                                  |
| ----------------------------- | -------------------------------------------- |
| `GET /api/telegram`           | Returns the configuration without the token. |
| `POST /api/telegram`          | Saves token, chat ID and enabled state.      |
| `POST /api/telegram/test`     | Sends a test message.                        |
| `POST /api/telegram/discover` | Detects chats with `getUpdates`.             |
| `DELETE /api/telegram`        | Removes the integration and its token.       |

## Headless Telegram mode

To run only the Telegram notifier without the web UI and without Docker, use
the manual installation from [Option B](#option-b--manual-installation):

```bash
cd server
npm run telegram -- \
  --bot-token "123456:ABC..." \
  --user "nombre.apellido@educa.jcyl.es" \
  --password "tu-contraseña"
```

If `--chat-id` is omitted, the script calls `getUpdates` and uses the most
recent chat. Open the bot in Telegram and send `/start` first. You can pass
`--chat-id 123456789` explicitly and `--interval 5` to change the polling
interval in minutes.

The process stays in the foreground and keeps running, logging each check. To
run it in the background:

```bash
npm run telegram -- ... --detach
tail -f telegram-cli.log
npm run telegram -- --stop
```

The CLI writes `server/telegram-cli.log` and `server/telegram-cli.pid` (both
git-ignored). The first run marks the current messages as already notified;
later runs send messages that arrived since the previous run. It shares the
SQLite account and Telegram state with the web server; tokens are encrypted and
renewed automatically.

For sensitive values, use environment variables instead of arguments:

```bash
TELEGRAM_BOT_TOKEN="..." STILUS_USER="..." STILUS_PASSWORD="..." \
  npm run telegram -- --chat-id 123456789
```

`STILUS_PASSWORD` and `TELEGRAM_BOT_TOKEN` avoid exposing the secrets in the
process list. The CLI polls only the account it signs in with. If the web server
is also running, per-account database locks prevent duplicate notifications; the
web server continues polling other accounts.

For Docker, use the `telegram` profile instead of `--detach`; see the
[Docker reference](#docker-reference).

## Docker reference

This is the full reference for [Option A](#option-a--docker-recommended). The
repository includes a multi-stage `Dockerfile` and a `compose.yaml` with two
profiles. The image contains Node, Python, Firefox ESR and a pinned geckodriver,
so the host does not need Firefox, Python or a virtual environment.

### What runs

- **`web` profile**: a single `server` container with Express, the compiled
  React frontend, Python/Selenium, Firefox and geckodriver.
- **`telegram` profile**: a single `telegram` container running only the
  headless CLI. It starts no web server or UI.
- Both profiles can run at once, but see the warning below.

New files:

```text
Dockerfile
compose.yaml
.dockerignore
config.docker.yaml
.env.example
```

### Prepare the environment

```bash
cp .env.example .env
```

`.env` is ignored by Git and is read by Compose. `.env.example` documents the
available variables. The web profile does not need Telegram credentials; users
log in through the UI.

| Variable              | Used by  | Default      | Description                                                               |
| --------------------- | -------- | ------------ | ------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`  | telegram | empty        | Bot token from `@BotFather`. Required for the Telegram profile.           |
| `TELEGRAM_CHAT_ID`    | telegram | empty        | Destination chat. If empty, the CLI tries to detect it.                   |
| `STILUS_USER`         | telegram | empty        | Educa username for the CLI login.                                         |
| `STILUS_PASSWORD`     | telegram | empty        | Educa password for the CLI login.                                         |
| `STILUS_BIND_ADDRESS` | web      | `127.0.0.1`  | Host bind address. Use `0.0.0.0` for LAN access.                          |
| `STILUS_WEB_PORT`     | web      | `8000`       | Host port for the web UI. Change it if the port is already in use.        |
| `STILUS_DATA_PATH`    | both     | named volume | Absolute host path for `/data` (Unraid: `/mnt/user/appdata/stilus/data`). |
| `PUID` / `PGID`       | both     | `10001`      | UID/GID for the container process. Unraid commonly uses `99:100`.         |
| `COOKIE_SECURE`       | web      | `false`      | Set to `true` when the UI is served through HTTPS.                        |

Inside the containers the image sets:

```text
STILUS_DATA_DIR=/data
STILUS_CONFIG=/app/config.docker.yaml
PYTHON=/opt/venv/bin/python
HOST=0.0.0.0
PORT=8000

# Compose adds:
HOME=/tmp
TMPDIR=/tmp
COOKIE_SECURE=false
```

`config.docker.yaml` contains only the Stilus URL and the geckodriver path. It
has no credentials.

### Start the web profile

```bash
docker compose --profile web up -d --build
```

Open <http://127.0.0.1:8000>. Express and the React build run in the same
container.

If port 8000 is busy on the host, change `STILUS_WEB_PORT` in `.env` (for
example to `18000`) and use that port. For access from another machine (for
example Ubuntu server), set:

```dotenv
STILUS_BIND_ADDRESS=0.0.0.0
STILUS_WEB_PORT=8000
```

The API uses the browser's `HttpOnly` session cookie to select the Stilus
account. There is no separate application password beyond the Stilus login. Do
not expose the port to an untrusted network without a reverse proxy and HTTPS;
set `COOKIE_SECURE=true` when HTTPS is in use.

### Start the Telegram-only profile

Fill the Telegram and Educa values in `.env`, then:

```bash
docker compose --profile telegram up -d --build
docker compose --profile telegram logs -f telegram
```

The container runs `node server/telegram-cli.js --interval 5` in the
foreground; Compose manages it. Do not use `--detach` or `--stop` inside the
container.

- The bot must have received a message; open it in Telegram and send `/start`.
- If `TELEGRAM_CHAT_ID` is empty, the CLI calls `getUpdates` to detect the
  chat. Setting the ID explicitly is more reproducible.
- The first run marks the current messages as already notified.
- Messages that arrive while the container is stopped are sent on the next
  start.
- The Telegram container has `restart: on-failure:5`; if the environment is
  incomplete it will stop after five attempts. Check the logs.

### Run both profiles

```bash
docker compose --profile web --profile telegram up -d --build
```

The web server polls every account that has Telegram enabled. The CLI polls
only the account it signs in with. Both use per-account rows in the
`telegram_locks` SQLite table, so a message is not sent twice.

> **Warning:** running both profiles is supported, but both may try to refresh
> the same account's token at the same time. Prefer the `web` profile alone; it
> already polls Telegram. Use the `telegram` profile only if you do not need the
> UI, or keep it for an account not used by the web login.

### Persistent data

The named volume `stilus-data` is mounted at `/data` and stores:

- `stilus.sqlite` plus its `-wal`/`-shm` files
- `.session.key`

The database contains accounts, encrypted tokens and credentials, browser
sessions (hashed identifiers), read state, Telegram settings, notified messages
and locks. Old installations' `session.json`, `read-state.json` and
`telegram.json` are imported into SQLite and removed on first startup.

Back up the whole data directory while the stack is stopped. The database and
`.session.key` are both required; without the key the encrypted tokens and
credentials cannot be recovered.

`docker compose down` keeps the volume. `docker compose down -v` deletes it,
including all accounts, sessions, read state and Telegram configuration. Docker
starts with its own empty state; existing host-side files are not copied
automatically.

The container runs with the UID/GID from `PUID`/`PGID` (default `10001:10001`).
The image creates `/data` for the default user with mode `0700`; database and key
files are written with mode `0600`. The web server and CLI share the same
volume and coordinate through SQLite locks.

### Unraid

Unraid appdata is normally owned by `nobody:users` (`99:100`). Set these values in
`.env` or in the stack environment:

```dotenv
PUID=99
PGID=100
STILUS_DATA_PATH=/mnt/user/appdata/stilus/data
```

Then make sure the bind-mounted data directory is writable by that user:

```bash
mkdir -p /mnt/user/appdata/stilus/data
chown -R 99:100 /mnt/user/appdata/stilus/data
chmod 700 /mnt/user/appdata/stilus/data
```

With `STILUS_DATA_PATH` set, Compose bind-mounts that directory at `/data`.
The container also sets `HOME=/tmp` so Firefox/Selenium do not need a writable
home directory in appdata. If you use a named volume instead of a bind mount,
create it with the same UID/GID or run `chown -R 99:100` inside it once.

After recreating the stack, verify permissions from inside the running web
container:

```bash
docker compose --profile web exec server sh -c \
  'id && touch /data/.write-test && rm /data/.write-test'
```

The command should report UID 99 and finish without `Permission denied`. On
first start, the logs should mention that legacy JSON data was migrated to
SQLite. Log in once from each browser; cookies keep the accounts separate.

### Useful commands

```bash
# Logs
docker compose --profile web logs -f server
docker compose --profile telegram logs -f telegram

# Status
docker compose --profile web ps
docker compose --profile telegram ps

# Stop (keep the data volume)
docker compose --profile web down
docker compose --profile telegram down
docker compose --profile web --profile telegram down

# Stop and delete all accounts, sessions, read state and Telegram data
docker compose --profile web --profile telegram down -v

# Rebuild after changing source or the Dockerfile
docker compose --profile web up -d --build
docker compose --profile telegram up -d --build
```

With no `--profile`, Compose starts neither service because both are
profile-scoped. This is intentional.

### Image details

- Multi-stage build: Vite frontend, server dependencies (including the native
  SQLite module) and the runtime image.
- Runtime base: `node:20-bookworm`.
- Python 3.11 virtual environment with `requirements.txt`.
- Debian Firefox ESR.
- Geckodriver pinned to **0.37.1**.
- SQLite database in `/data`; no external database container is required.
- Frontend compiled into `frontend/dist` and served by Express.
- Runs with `PUID`/`PGID` (default non-root UID/GID 10001), `init: true`,
  `shm_size: 1gb` for Firefox.
- Healthcheck against `/api/health` for the web service.

The image supports `linux/amd64` and `linux/arm64`. BuildKit supplies
`TARGETARCH`, and the Dockerfile downloads the matching geckodriver release
(`linux64` or `linux-aarch64`). Debian provides Firefox ESR for both
architectures. The final image is roughly 2.3 GB because it includes Firefox and
its runtime dependencies.

### Verification performed

The previous `amd64` image was built and tested: the web container started, the
frontend and `/api/health` responded, Firefox/geckodriver started, the Stilus
login page loaded and the Telegram CLI `--help` worked.

For this multi-user revision, the Node server and SQLite layer were tested
directly on Node 20:

- Two browser cookie jars logged in as two different accounts and received
  their own usernames from `/api/token`; logging out one left the other intact.
- An expired migrated token was renewed automatically, and a valid token was
  not renewed again.
- Legacy `session.json`, `read-state.json` and `telegram.json` were migrated to
  SQLite and removed.
- The Telegram configuration and account-deletion endpoints worked with the
  session cookie.
- The frontend production build, Prettier, ESLint, `node --check` and
  `docker compose config` pass.

The Docker daemon on the development machine was unresponsive at the end, so
the current SQLite revision could not be rebuilt into the image there. Rebuild it
on the target before deploying. The Dockerfile downloads native/server
dependencies and keeps build tools out of the runtime stage.

For `arm64`, Debian's Firefox ESR package and the geckodriver `linux-aarch64`
release were verified. A complete `arm64` build on the earlier x86 host through
QEMU failed during the emulated `pip install` because PyPI was unreachable; the
Dockerfile itself is architecture-aware. A native ARM host (Apple Silicon or an
ARM server) should build it without emulation.

### Docker troubleshooting

| Problem                                   | Check                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up` starts no services    | Both services use profiles. Pass `--profile web`, `--profile telegram`, or both.                                                                                       |
| The web port is already in use            | Set `STILUS_WEB_PORT` in `.env` or stop the process using port 8000.                                                                                                   |
| The web UI is not reachable from the LAN  | Set `STILUS_BIND_ADDRESS=0.0.0.0` and check the host firewall.                                                                                                         |
| The Telegram container exits repeatedly   | Check `.env`: bot token, username and password are required; inspect `logs -f telegram`.                                                                               |
| Telegram cannot detect a chat             | Open the bot, send `/start`, or set `TELEGRAM_CHAT_ID` explicitly.                                                                                                     |
| Both profiles run at once                 | Supported with a warning: database locks prevent duplicate Telegram sends, but simultaneous token refresh for the same account can race. Prefer the web profile alone. |
| Permission denied writing `/data`         | Set `PUID`/`PGID` to the owner of the bind mount (Unraid: `99:100`) and `chown -R` the appdata directory.                                                              |
| Session/Telegram data disappeared         | `docker compose down -v` deletes the named volume.                                                                                                                     |
| The image needs a rebuild after changes   | Run `up -d --build` again; Docker reuses cached layers where possible.                                                                                                 |
| Docker build cannot download dependencies | The build needs access to Docker Hub, Debian repositories, GitHub and PyPI.                                                                                            |
