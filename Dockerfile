# syntax=docker/dockerfile:1
FROM node:24.22.1-alpine

WORKDIR /var/src

# Manifests first for layer caching
COPY --chown=node:node ./src/package.json ./src/package-lock.json ./

# Production deps only, deterministic install, npm cache mount
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps

# App source (.dockerignore must exclude node_modules and .env)
COPY --chown=node:node ./src/ ./

USER node
EXPOSE 3000
CMD ["node", "app.js"]
