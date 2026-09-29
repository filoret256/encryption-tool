# syntax=docker/dockerfile:1

# Every base image below is pinned by digest as well as by tag. A tag is a name
# somebody else can move: `oven/bun:1` is whatever the latest 1.x is on the day of
# the build, so two builds of the same commit could differ, and a compromised or
# mistaken push to a base image would land in this one — including the code-agent
# binaries this image hands to users. The tag is kept for the reader; the digest
# is what is pulled.
#
# To move them on purpose: `bun scripts/pin-images.ts --write`, then review the
# diff and rebuild. Left to itself the pin never moves, which means security
# updates to the base images arrive only when someone does that — schedule it.

# Which code-agents to ship. Every target adds about 3 MB to the image, so the full
# set is the default; pass an empty string to ship none and point
# CODE_AGENT_DOWNLOAD_BASE at a mirror instead.
ARG CODE_AGENT_TARGETS="windows-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64"

# ── Stage 1: bundle the frontend and compile a standalone server binary ──
FROM oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ ./src/
# Build the browser bundle (-> public/), then compile the server into a single
# self-contained executable with the frontend assets embedded (see src/server.ts).
RUN bun run build \
 && bun build --compile --minify --sourcemap=none --target=bun-linux-x64 \
      --outfile server src/server.ts

# ── Stage 2: cross-compile the local code-agent for the desktop platforms ──
#
# The code tab needs a code-agent on the user's own machine; one running in this
# container would expose the container. So the image carries the binaries and
# hands them out (see the /code-agent/downloads route).
#
# The code-agent is the Go program in code-agent-go/ — the same protocol as the
# TypeScript one, about a twelfth of the size, because a Bun binary has to embed
# the whole runtime. With CGO_ENABLED=0 all five targets cross-compile from this
# one Linux image: no per-target SDK, no linker for the far side, and nothing
# downloaded at build time except two Go modules.
#
# The toolchain is lifted out of the official Go image rather than driving the
# build from it, so the target table and the manifest writer stay in one
# TypeScript file (scripts/build-code-agents.ts) instead of being restated in shell.
#
# Deliberately independent of the builder stage: nothing here needs
# `bun install` or the frontend, so this layer is rebuilt only when the code-agent's
# own sources change — not on every frontend edit.
FROM oven/bun:1@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS code-agents

RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=golang:1.27@sha256:3680233e3204827fbdc66088528ae6d4b3d034f51d03a99d454f6de034888244 /usr/local/go /usr/local/go
ENV GO_BIN=/usr/local/go/bin/go \
    GOTOOLCHAIN=local \
    GOPATH=/tmp/go \
    GOCACHE=/tmp/go-build

COPY src/version.ts ./src/
COPY src/code-agent/targets.ts ./src/code-agent/
COPY code-agent-go/ ./code-agent-go/
COPY scripts/archive.ts scripts/build-code-agents.ts scripts/go-toolchain.ts ./scripts/

ARG CODE_AGENT_TARGETS
RUN bun scripts/build-code-agents.ts --targets "$CODE_AGENT_TARGETS" --out /code-agents

# ── Stage 3: minimal Debian runtime — just the compiled executable ──
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
WORKDIR /app

# Bun's glibc executable links against libstdc++/libgcc at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home appuser

# Copied before the server binary on purpose: this is the slower-changing layer,
# so a rebuild of the app alone leaves it cached on the nodes.
COPY --from=code-agents /code-agents /usr/local/share/enc-tool/code-agents
COPY --from=builder /app/server /usr/local/bin/server

USER appuser
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["server", "--health"]

ENTRYPOINT ["server"]
