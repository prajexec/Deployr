# Pinned Node.js 20 Alpine base image
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# Install git and bash/ca-certificates
RUN apk add --no-cache git ca-certificates openssh-client

# Create unprivileged builduser (UID/GID 10001)
RUN addgroup -g 10001 builduser && \
    adduser -u 10001 -G builduser -s /bin/sh -D builduser

# Enable corepack for pnpm and yarn
RUN corepack enable

# Copy and set permissions on fixed entrypoint
COPY docker/builder/build-entrypoint.sh /usr/local/bin/build-entrypoint.sh
RUN chmod 755 /usr/local/bin/build-entrypoint.sh

# Prepare mount points with proper ownership
RUN mkdir -p /build /tmp && \
    chown -R builduser:builduser /build /tmp

USER 10001:10001
WORKDIR /build

ENTRYPOINT ["/usr/local/bin/build-entrypoint.sh"]
