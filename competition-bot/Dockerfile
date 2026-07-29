FROM node:22-slim AS base
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────
FROM base AS deps
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true
COPY package.json ./
RUN npm install

# ── Build backend ─────────────────────────────────────────────────────
FROM deps AS build-backend
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ── Build admin UI ────────────────────────────────────────────────────
FROM base AS build-ui
WORKDIR /app/admin-ui
COPY admin-ui/package.json ./
RUN npm install
COPY admin-ui/ ./
RUN npm run build

# ── Production runtime ────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

# Install system dependencies that Playwright's Firefox needs (fonts, etc.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgdk-pixbuf-2.0-0 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-xcb1 \
    libx11-6 \
    libxcb1 \
    libxcursor1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxt6 \
    libxtst6 \
    iproute2 \
    iptables \
    openresolv \
    wireguard-tools \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# Copy package.json and install production deps
COPY package.json ./
RUN npm install --omit=dev

# Install Playwright's bundled Firefox (guaranteed compatible version)
# npx playwright install firefox downloads Firefox to /root/.cache/ms-playwright
RUN npx playwright install firefox

# Disable automatic browser download in case npm scripts run again
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true

COPY --from=build-backend /app/dist ./dist
COPY --from=build-ui /app/admin-ui/dist ./admin-ui/dist

ENV NODE_ENV=production
EXPOSE 3456

CMD ["node", "dist/index.js"]
