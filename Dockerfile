# day2 orchestrator (API + background backlog work).
# Built and run by deploy/compose.yaml — see docs/deploy-hetzner.md.
FROM oven/bun:1.4.2-slim

# git + gh: cloning, branches, PRs (with each account's GitHub App token).
# bubblewrap + socat: the agent sandbox (agent-sandbox.ts) — it refuses to
# run agents without them. unzip: .zip uploads.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git unzip bubblewrap socat gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Commits day2 makes in customer repos are authored as day2.
RUN git config --system user.name "day2" \
 && git config --system user.email "bot@day2.dev" \
 && git config --system init.defaultBranch main

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY sdk ./sdk

# Customer app checkouts and day2's own state live on volumes.
RUN mkdir -p /app/managed-repos /data && chown -R bun:bun /app/managed-repos /data
USER bun

ENV NODE_ENV=production \
    DAY2_CONSOLE_API_PORT=4700 \
    DAY2_DATA_DIR=/data
EXPOSE 4700
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:4700/api/features || exit 1
CMD ["bun", "run", "src/api-server.ts"]
