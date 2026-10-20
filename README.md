# Stilus

Fetch communications from the
[Stilus](https://stilus.educa.jcyl.es/) portal.

## How to run

There are two supported ways to use the project:

| Option                  | Host requirements                                               | Recommended for                                   |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| **Docker**              | Docker Engine/Desktop 24+ with Docker Compose v2. Nothing else. | Normal use and servers.                           |
| **Manual installation** | Python 3.10+, Node.js 18.18+, Firefox and geckodriver.          | Development or modifying the code without Docker. |

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

> **Warning:** both services share the `stilus-data` volume and the
> `telegram.lock` lock. The lock prevents duplicate Telegram sends, but both
> processes poll Stilus and share the same session. Running just one profile is
> recommended.

Docker state is stored in the named volume `stilus-data`; it is separate from
the host's local `session.json` and `telegram.json`. `docker compose down` keeps
the volume, while `docker compose down -v` deletes it.

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
- Node.js 18.18 or newer for the Express API and tooling.
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

## Web login and token renewal

The React frontend provides a login form that runs `get_token.py` through a
small Express API. After a successful login the API stores a session in
`session.json` (git-ignored):

- The access token and its generation time.
- Your username and password, encrypted with AES-256-GCM.

The encryption key is generated locally in `.session.key` (mode `0600`,
git-ignored).

The server uses the stored token while its JWT `exp` is in the future. It reads
`exp` internally only to detect actual expiry; it does **not** renew early and
does **not** run a background renewal timer. When `exp` has passed, the next
request to Stilus renews the token once with the stored credentials and
continues. A portal `401` triggers the same renewal. If the portal rejects the
stored credentials, the session is removed and the login form is shown again.

Logging out with "Olvidar sesión" deletes `session.json`. The password is sent
to `get_token.py` through stdin and never placed in process arguments.

The API exposes `GET /api/token` so other local tools can obtain the current
token without running Selenium. It renews only if the stored token is already
expired. `POST /api/token/refresh` forces a new login and token, and
`POST /api/logout` deletes the stored session.

> `session.json`, `telegram.json` and `.session.key` live on this machine.
> Anyone with access to your user account and these files can decrypt the
> password and bot token, so protect your account and do not commit them. For
> stronger isolation, use the OS keychain.

## Inbox

When a session is active, the frontend shows the family inbox:

- It fetches the children from `GET /matriculas/educacyl` and their received
  communications from `GET /comunicaciones/{matriculaId}`.
- Messages shared by several children are merged into a single entry.
- You can search by subject, sender or text, filter unread messages, filter by
  child and select one or more grouped senders in a multi-select dropdown.
- Opening an unread message marks it as read in Stilus and stores the state in
  `read-state.json` (git-ignored), keyed by user and message UUID.
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

The bot token is encrypted with AES-256-GCM and stored in `telegram.json`
(git-ignored, mode `0600`). It is never sent back to the browser; only its last
four characters are shown as a hint.

Once configured, the server checks for new messages every 5 minutes,
independently of whether the web UI is open. Each new message is sent to the
configured chat with its subject, sender, children, date, type and full text.
Attachments are downloaded from Stilus and sent as Telegram documents. The
**Probar** button sends a test message, and **Eliminar integración** removes the
stored token and stops notifications.

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
later runs send messages that arrived since the previous run. It reuses
`session.json` and `telegram.json`, so the bot token is encrypted and the Stilus
token is renewed automatically.

For sensitive values, use environment variables instead of arguments:

```bash
TELEGRAM_BOT_TOKEN="..." STILUS_USER="..." STILUS_PASSWORD="..." \
  npm run telegram -- --chat-id 123456789
```

`STILUS_PASSWORD` and `TELEGRAM_BOT_TOKEN` avoid exposing the secrets in the
process list. The CLI and the web server share `session.json` and
`telegram.json`; a lock file (`telegram.lock`) prevents duplicate notifications,
but running both at the same time is unnecessary.

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

| Variable              | Used by  | Default     | Description                                                        |
| --------------------- | -------- | ----------- | ------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`  | telegram | empty       | Bot token from `@BotFather`. Required for the Telegram profile.    |
| `TELEGRAM_CHAT_ID`    | telegram | empty       | Destination chat. If empty, the CLI tries to detect it.            |
| `STILUS_USER`         | telegram | empty       | Educa username for the CLI login.                                  |
| `STILUS_PASSWORD`     | telegram | empty       | Educa password for the CLI login.                                  |
| `STILUS_BIND_ADDRESS` | web      | `127.0.0.1` | Host bind address. Use `0.0.0.0` for LAN access.                   |
| `STILUS_WEB_PORT`     | web      | `8000`      | Host port for the web UI. Change it if the port is already in use. |

Inside the containers the image sets:

```text
STILUS_DATA_DIR=/data
STILUS_CONFIG=/app/config.docker.yaml
PYTHON=/opt/venv/bin/python
HOST=0.0.0.0
PORT=8000
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

The API has no authentication layer of its own beyond the Stilus session. Do
not expose it to an untrusted network without a reverse proxy and HTTPS.

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

> **Warning:** both services share the `stilus-data` volume and the
> `telegram.lock` lock. The lock prevents duplicate Telegram sends, but both
> processes poll Stilus and share the same session. Running just one profile is
> recommended. If both run, a token renewal can race; stop one of them if you
> see unexpected session errors.

### Persistent data

The named volume `stilus-data` is mounted at `/data` and stores:

- `session.json`
- `.session.key`
- `read-state.json`
- `telegram.json`
- `telegram.lock`

`docker compose down` keeps the volume. `docker compose down -v` deletes it,
including the saved session and Telegram configuration. Docker starts with its
own empty state; existing host-side session files are not copied automatically.

The container runs as the unprivileged `app` user (UID 10001), and `/data` is
created with mode `0700` and owned by that user. Session files are written with
mode `0600`. The web server and the CLI share the same volume, session, read
state and Telegram lock.

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

# Stop and delete session/Telegram data
docker compose --profile web --profile telegram down -v

# Rebuild after changing source or the Dockerfile
docker compose --profile web up -d --build
docker compose --profile telegram up -d --build
```

With no `--profile`, Compose starts neither service because both are
profile-scoped. This is intentional.

### Image details

- Multi-stage build: Vite frontend build followed by the runtime image.
- Runtime base: `node:20-bookworm`.
- Python 3.11 virtual environment with `requirements.txt`.
- Debian Firefox ESR.
- Geckodriver pinned to **0.37.1**.
- Frontend compiled into `frontend/dist` and served by Express.
- Non-root `app` user, `init: true`, `shm_size: 1gb` for Firefox.
- Healthcheck against `/api/health` for the web service.

The image supports `linux/amd64` and `linux/arm64`. BuildKit supplies
`TARGETARCH`, and the Dockerfile downloads the matching geckodriver release
(`linux64` or `linux-aarch64`). Debian provides Firefox ESR for both
architectures. The final image is roughly 2.3 GB because it includes Firefox and
its runtime dependencies.

### Verification performed

The `amd64` image was built and tested:

- Web container starts, `/api/health` returns `200`.
- The compiled frontend is served at the web port.
- `/data` is writable by the `app` user.
- Firefox ESR 153.5.0 and geckodriver 0.37.1 start inside the container.
- The Stilus login page loads from inside the container.
- The Telegram CLI `--help` works inside the image.
- Prettier, ESLint and `docker compose config` pass.

For `arm64`, Debian's Firefox ESR package and the geckodriver `linux-aarch64`
release were verified. A complete `arm64` build on this x86 host through QEMU
failed during the emulated `pip install` because PyPI was unreachable from the
emulated environment; the Dockerfile itself is architecture-aware. A native
ARM host (Apple Silicon or an ARM server) should build it without emulation.

### Docker troubleshooting

| Problem                                   | Check                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `docker compose up` starts no services    | Both services use profiles. Pass `--profile web`, `--profile telegram`, or both.         |
| The web port is already in use            | Set `STILUS_WEB_PORT` in `.env` or stop the process using port 8000.                     |
| The web UI is not reachable from the LAN  | Set `STILUS_BIND_ADDRESS=0.0.0.0` and check the host firewall.                           |
| The Telegram container exits repeatedly   | Check `.env`: bot token, username and password are required; inspect `logs -f telegram`. |
| Telegram cannot detect a chat             | Open the bot, send `/start`, or set `TELEGRAM_CHAT_ID` explicitly.                       |
| Both profiles produce duplicate work      | The lock prevents duplicate Telegram sends, but stop one profile; see the warning above. |
| Session/Telegram data disappeared         | `docker compose down -v` deletes the named volume.                                       |
| The image needs a rebuild after changes   | Run `up -d --build` again; Docker reuses cached layers where possible.                   |
| Docker build cannot download dependencies | The build needs access to Docker Hub, Debian repositories, GitHub and PyPI.              |
