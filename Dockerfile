FROM node:22-slim AS base
WORKDIR /app
# node-pty needs to compile a native addon; python3/make/g++ are node-gyp's
# requirements. Left installed in the runtime image too rather than trying
# to strip them post-install -- worth slimming later if image size matters.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json ./
RUN npm install

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
# The remote-control feature spawns this CLI inside a pty -- it's the thing
# actually being remote-controlled, distinct from Custos's own OAuth client
# that talks to Anthropic on behalf of /v1/messages traffic.
RUN npm install -g @anthropic-ai/claude-code
COPY --from=build /app/dist ./dist
COPY public ./public
EXPOSE 8787
CMD ["node", "dist/index.js"]
