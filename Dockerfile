# syntax=docker/dockerfile:1

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

# ── Stage 2: minimal Debian runtime — just the compiled executable ──
FROM debian:bookworm-slim
WORKDIR /app

# Bun's glibc executable links against libstdc++/libgcc at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home appuser

COPY --from=builder /app/server /usr/local/bin/server

USER appuser
ENV PORT=5000
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["server", "--health"]

ENTRYPOINT ["server"]
