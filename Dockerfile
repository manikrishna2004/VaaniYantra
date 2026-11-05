# The web app, as a client-cloud runtime.
#
# ── What this is FOR, and what it is not ────────────────────────────────────
#
# This image is how a DEDICATED install ships: a client runs it in their own
# cloud, with their own Postgres, and their ops team has root on the box.
#
# It is NOT how our shared VM deploys. That still goes through
# scripts/deploy.sh — tar, scp, build on the VM, health-gate, auto-rollback —
# and converting a working, heavily-annotated deploy path in the same change
# that introduces a second one is a bigger risk than briefly having two
# mechanisms. Docker for client installs first; the shared VM migrates later,
# if ever.
#
# ── Why the image is built in CI, not on a VM ───────────────────────────────
#
# The reason deploy.sh insists on building on the target box is that Turbopack
# bakes a content-hashed reference to the resolved Prisma client into the server
# chunks, so a build from a different machine dies at startup with "Cannot find
# module @prisma/client-<hash>". An image does not have that problem: the image
# IS the runtime environment, built once and run byte-identically everywhere.
# That is also what removes the e2-medium memory ceiling that shapes deploy.sh.
#
# ── Tagging ─────────────────────────────────────────────────────────────────
#
# Immutable tags only — vaaniyantra/runtime:2026.09.03-4ab3175, never `latest`.
# A client's box has to be able to say precisely what it runs, and the heartbeat
# reports exactly this string. (The plan wrote the tag with a `+`; Docker tags
# do not permit one, so the build metadata is joined with a `-`.)

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# openssl: Prisma's query engine links against it and the slim image omits it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Placeholders, present only so `next build` can collect page data — the same
# reason CI sets them. Every page that touches the database is force-dynamic,
# so nothing connects at build time and none of these reach the runtime image.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public" \
    SECRET_ENC_KEY="build-only-not-a-real-key" \
    NEXT_PUBLIC_FIREBASE_API_KEY="build-placeholder" \
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="build-placeholder.firebaseapp.com" \
    NEXT_PUBLIC_FIREBASE_PROJECT_ID="build-placeholder" \
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET="build-placeholder.appspot.com" \
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID="000000000000" \
    NEXT_PUBLIC_FIREBASE_APP_ID="1:000000000000:web:0000000000000000" \
    NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate && npx next build

# ── Runtime ─────────────────────────────────────────────────────────────────
#
# The whole app directory is carried across rather than a `standalone` trace.
# Turning on `output: 'standalone'` would change what `next build` emits on the
# shared VM too, and that build is the only thing between a bad push and the
# live site. A larger image is the cheaper of the two risks.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    # Every image is a client install until its environment says otherwise.
    # The default is the SAFE one: a box that forgets to set this gets no admin
    # surface rather than a full one. requireSharedDeployment() reads it at
    # runtime, never at build time, which is what makes this work at all.
    DEPLOYMENT_MODE=dedicated

COPY --from=builder /app ./

# node, not npm: npm swallows SIGTERM, so `docker stop` would sit through its
# whole timeout on every restart and kill the process rather than let Next shut
# down. Run the server directly so signals reach it.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

USER node
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
