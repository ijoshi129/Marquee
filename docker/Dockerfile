# Base images pinned to digests so rebuilds are reproducible. Bump these
# manually when you want to pick up upstream security patches.
ARG NODE_IMAGE=node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

FROM ${NODE_IMAGE} AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client ./
RUN npm run build

FROM ${NODE_IMAGE}
# postgresql16-client gives the runtime container a `pg_dump` binary matching
# the bundled Postgres 16 server, used by the daily backup worker.
RUN apk add --no-cache postgresql16-client
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
COPY --from=client-build /app/client/dist ./client/dist
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "server.js"]
