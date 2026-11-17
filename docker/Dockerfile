# Base images pinned to digests so rebuilds are reproducible. Bump these
# manually when you want to pick up upstream security patches.
ARG NODE_IMAGE=node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ARG GO_IMAGE=golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280

FROM ${GO_IMAGE} AS tailcat-build
WORKDIR /src
COPY tailcat/go.mod tailcat/go.sum ./
RUN go mod download
COPY tailcat ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/marquee-tailcat .

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
COPY --from=tailcat-build /out/marquee-tailcat /usr/local/bin/marquee-tailcat
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "server.js"]
