# syntax=docker/dockerfile:1

# Which agents to ship. Every target adds about 3 MB to the image, so the full
# set is the default; pass an empty string to ship none and point
# AGENT_DOWNLOAD_BASE at a mirror instead.
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
# The agent is the Go program in agent-go/ — the same protocol as the
# TypeScript one, about a twelfth of the size, because a Bun binary has to embed
# the whole runtime. With CGO_ENABLED=0 all five targets cross-compile from this
# one Linux image: no per-target SDK, no linker for the far side, and nothing
# downloaded at build time except two Go modules.
#
# The toolchain is lifted out of the official Go image rather than driving the
# build from it, so the target table and the manifest writer stay in one
# TypeScript file (scripts/build-agents.ts) instead of being restated in shell.
#
# Deliberately independent of the builder stage: nothing here needs
# `bun install` or the frontend, so this layer is rebuilt only when the agent's
# own sources change — not on every frontend edit.
FROM oven/bun:1 AS agents
WORKDIR /app

COPY --from=golang:1.27 /usr/local/go /usr/local/go
ENV GO_BIN=/usr/local/go/bin/go \
    GOTOOLCHAIN=local \
    GOPATH=/tmp/go \
    GOCACHE=/tmp/go-build

COPY src/version.ts ./src/
COPY src/agent/targets.ts ./src/agent/
COPY agent-go/ ./agent-go/
COPY scripts/archive.ts scripts/build-agents.ts scripts/go-toolchain.ts ./scripts/

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

# Copied before the server binary on purpose: this is the slower-changing layer,
# so a rebuild of the app alone leaves it cached on the nodes.
COPY --from=agents /agents /usr/local/share/enc-tool/agents
COPY --from=builder /app/server /usr/local/bin/server

USER appuser
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["server", "--health"]

ENTRYPOINT ["server"]
