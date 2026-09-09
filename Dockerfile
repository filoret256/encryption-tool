# syntax=docker/dockerfile:1

# Which agents to ship. Every target adds 25-40 MB to the image, so a
# deployment that only serves one platform can trim the list — or pass an empty
# string to ship none and point AGENT_DOWNLOAD_BASE at a mirror instead.
ARG AGENT_TARGETS="windows-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64"

# ── Stage 1: bundle the frontend and compile a standalone server binary ──
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ ./src/
# Build the browser bundle (-> public/), then compile the server into a single
# self-contained executable with the frontend assets embedded (see src/server.ts).
RUN bun run build \
 && bun build --compile --minify --sourcemap=none --target=bun-linux-x64 \
      --outfile server src/server.ts

# ── Stage 2: cross-compile the local agent for the desktop platforms ──
#
# The code tab needs an agent on the user's own machine; one running in this
# container would expose the container. So the image carries the binaries and
# hands them out (see the /agent/downloads route).
#
# Deliberately independent of the builder stage: src/agent/cli.ts imports only
# node built-ins, so no `bun install` is needed and this layer is rebuilt only
# when the agent's own sources change — not on every frontend edit. Needs
# network access, as Bun fetches each target's runtime while compiling.
FROM oven/bun:1 AS agents
WORKDIR /app

COPY src/version.ts ./src/
COPY src/agent/ ./src/agent/
COPY scripts/archive.ts scripts/build-agents.ts ./scripts/

ARG AGENT_TARGETS
RUN bun scripts/build-agents.ts --targets "$AGENT_TARGETS" --out /agents

# ── Stage 3: minimal Debian runtime — just the compiled executable ──
FROM debian:bookworm-slim
WORKDIR /app

# Bun's glibc executable links against libstdc++/libgcc at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home appuser

# Copied before the server binary on purpose: this is the large, slow-changing
# layer, so a rebuild of the app alone leaves it cached on the nodes.
COPY --from=agents /agents /usr/local/share/enc-tool/agents
COPY --from=builder /app/server /usr/local/bin/server

USER appuser
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["server", "--health"]

ENTRYPOINT ["server"]
