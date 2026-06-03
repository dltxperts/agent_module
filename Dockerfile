# syntax=docker/dockerfile:1.6
#
# Agent sidecar Dockerfile for Railway.
# Build context = agent/ (self-contained).
# In Railway: set Root Directory = "/agent" and Dockerfile Path = "Dockerfile".
#
# Railway injects env vars directly, so we do NOT use bun's --env-file flag here
# (the dev script uses --env-file=../.env which is not available in-container).

FROM oven/bun:1 AS runtime

WORKDIR /app

# Install deps first for better layer caching. Keep bun.lock for --frozen-lockfile.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy the rest of the agent source.
COPY . .

ENV AGENT_PORT=3002

EXPOSE 3002

CMD ["bun", "src/index.ts"]
