FROM node:22-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN npm install

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The project UI (the same React app the desktop client runs) is built
# separately -- it has its own dependency tree and bundler, and nothing in
# the server needs them at runtime.
FROM base AS ui
WORKDIR /ui
COPY ui/package.json ./
RUN npm install
COPY ui/ ./
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production

# The engineering pipeline runs real development work in here, so the tools
# that work needs have to exist: git (every ticket is worked in its own
# worktree on its own branch), the GitHub CLI (engineers open pull requests,
# QA comments on them), and ca-certificates/curl for anything they fetch.
# node:*-slim ships none of these.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Agents commit as themselves rather than inheriting whatever identity the
# host happens to have; without this git refuses to commit at all in a
# fresh container.
RUN git config --system user.name "Custos Agent" \
  && git config --system user.email "agents@custos.local" \
  && git config --system --add safe.directory '*' \
  && git config --system init.defaultBranch main \
  # Reads the token from the environment Custos injects from its vault (see
  # src/pm/vault.ts) rather than from a credentials file. Nothing is written
  # to disk, and the token never has to appear in a remote URL -- which is
  # what usually leaks it, since remotes end up in logs and in `git remote -v`.
  && git config --system credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'

COPY package.json ./
RUN npm install --omit=dev
# The remote-control feature spawns this CLI, one-shot per chat turn --
# it's the thing actually being remote-controlled, distinct from Custos's
# own OAuth client that talks to Anthropic on behalf of /v1/messages traffic.
RUN npm install -g @anthropic-ai/claude-code
COPY --from=build /app/dist ./dist
COPY --from=ui /ui/dist ./ui-dist
COPY public ./public
EXPOSE 8787
CMD ["node", "dist/index.js"]
