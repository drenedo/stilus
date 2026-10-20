# syntax=docker/dockerfile:1

ARG NODE_VERSION=20
ARG GECKODRIVER_VERSION=0.37.1

# ---------------------------------------------------------------------------
# Frontend build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime: Node + Python/Selenium + Firefox + geckodriver
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm AS runtime

ARG TARGETARCH
ARG GECKODRIVER_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        firefox-esr \
        fonts-dejavu-core \
        fonts-liberation \
        libasound2 \
        libdbus-glib-1-2 \
        libgbm1 \
        libgtk-3-0 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        python3 \
        python3-venv \
        tar \
    && rm -rf /var/lib/apt/lists/*

# Selenium expects a `firefox` executable; Debian provides `firefox-esr`.
RUN ln -sf /usr/bin/firefox-esr /usr/local/bin/firefox

# Install a pinned geckodriver for both supported architectures.
RUN ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "${ARCH}" in \
        amd64) GECKO_ARCH="linux64" ;; \
        arm64) GECKO_ARCH="linux-aarch64" ;; \
        *) echo "Unsupported container architecture: ${ARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL \
        "https://github.com/mozilla/geckodriver/releases/download/v${GECKODRIVER_VERSION}/geckodriver-v${GECKODRIVER_VERSION}-${GECKO_ARCH}.tar.gz" \
        -o /tmp/geckodriver.tar.gz \
    && tar -xzf /tmp/geckodriver.tar.gz -C /usr/local/bin \
    && chmod 0755 /usr/local/bin/geckodriver \
    && rm /tmp/geckodriver.tar.gz \
    && geckodriver --version

WORKDIR /app

# Python dependencies for get_token.py / Selenium.
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Server dependencies.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# Application code and the built frontend.
COPY get_token.py ./
COPY server/ ./server/
COPY config.docker.yaml ./
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Run as an unprivileged user; /data is the persistent state volume.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin app \
    && mkdir -p /data \
    && chown -R app:app /data /home/app

USER app

ENV HOST=0.0.0.0 \
    PORT=8000 \
    PYTHON=/opt/venv/bin/python \
    STILUS_CONFIG=/app/config.docker.yaml \
    STILUS_DATA_DIR=/data \
    HOME=/home/app \
    NODE_ENV=production

EXPOSE 8000

CMD ["node", "server/index.js"]
