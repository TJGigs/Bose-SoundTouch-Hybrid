# NOTE ON BUILD CONTEXT: this Dockerfile must be built with the REPO ROOT as
# context, not the ha-addon/ folder — it COPYs server.js, device_state.js,
# routes/, public/, templates/, package.json, all of which live one level up
# from this file. Supervisor's own "build this local add-on" flow always uses
# the add-on's own directory as context and cannot reach the repo root, so
# this image must be built and published in CI (extending
# .github/workflows/docker-publish.yml) and referenced from config.yaml via
# an `image:` tag. Do not try to install this as an unpublished local add-on
# expecting Supervisor to build it directly — it will only see this folder's
# four files and the COPY steps below will fail.

# ARG must precede the file's first FROM to stay in global scope, which is
# what makes it available for the $BUILD_FROM substitution below — declaring
# it between the two FROM lines (as the HA add-on template implies when you
# add a stage above it) leaves it undeclared for that later FROM.
ARG BUILD_FROM

# Borrow the exact Node 22 runtime from the official image rather than trusting
# whatever Node version Alpine's apk repo happens to carry for a given HA base
# tag — musl-linked, so it drops cleanly onto HA's alpine-based images.
FROM node:22-alpine AS nodejs

FROM $BUILD_FROM

COPY --from=nodejs /usr/local/bin/node /usr/local/bin/node
COPY --from=nodejs /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN apk add --no-cache tzdata

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .
RUN mkdir -p /app/config

COPY ha-addon/run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
