# Runtime image for `i18n-pipeline validate-ci` in shared Konflux pipelines.
#
# The Node 22 and Node 24 stages run the repository test suite. The runtime
# stage copies a marker from each, so the image only exists if both pass.
# Pin multi-architecture indexes, not individual platform manifests.
FROM registry.access.redhat.com/ubi9/nodejs-22:1-1791442403@sha256:e52f879096f28d9a6cfb308b3bf2c71c0fc35caec613060bbe41dac054002831 AS node22
USER 0
WORKDIR /opt/i18n-tooling
ENV COREPACK_HOME=/opt/corepack
COPY package.json ./
RUN npm install --global corepack@0.34.0 \
    && corepack enable npm \
    && corepack install --global "$(node -p "require('./package.json').packageManager")"
COPY --chown=1001:0 . .
RUN chown 1001:0 /opt/i18n-tooling
USER 1001
# The Corepack bootstrap populated the default npm cache as root.
ENV NPM_CONFIG_CACHE=/tmp/npm-cache
# The committed npm lockfile must stay unchanged during a clean install.
RUN sha256sum package-lock.json > /tmp/lockfiles.sha256 \
    && npm ci \
    && sha256sum --check /tmp/lockfiles.sha256
RUN npm run typecheck \
    && node --test scripts/*.test.mjs \
    && npm run test:coverage \
    && npm run build \
    && npm run smoke:cli \
    && touch /tmp/node22.passed

FROM registry.access.redhat.com/ubi9/nodejs-24:1-1791219316@sha256:36af0bcb31021be93b0aab49e3ebcbbe07326496a550cface3294634fe7e6433 AS node24
USER 0
WORKDIR /opt/i18n-tooling
ENV COREPACK_HOME=/opt/corepack
COPY package.json ./
RUN npm install --global corepack@0.34.0 \
    && corepack enable npm \
    && corepack install --global "$(node -p "require('./package.json').packageManager")"
COPY --chown=1001:0 . .
RUN chown 1001:0 /opt/i18n-tooling
USER 1001
ENV NPM_CONFIG_CACHE=/tmp/npm-cache
RUN npm ci
RUN npm run typecheck \
    && node --test scripts/*.test.mjs \
    && npm run test:coverage \
    && npm run build \
    && npm run smoke:cli \
    && touch /tmp/node24.passed

# Production dependencies only, from the same frozen lockfile.
FROM node22 AS production
# npm may hoist all dependencies, leaving workspace node_modules absent.
RUN rm -rf node_modules packages/*/node_modules \
    && npm ci --omit=dev \
    && mkdir -p packages/eslint-plugin-i18n/node_modules packages/i18n-pipeline/node_modules

FROM registry.access.redhat.com/ubi9/nodejs-22-minimal:1-1791441974@sha256:03b7dd64cafaaca5019c4cc1c36e05140b1650dab6cd5c4ab1fde9d88c0537ca AS runtime
USER 0
COPY --from=node22 /tmp/node22.passed /tmp/node22.passed
COPY --from=node24 /tmp/node24.passed /tmp/node24.passed
COPY --from=production /opt/i18n-tooling/package.json /opt/i18n-tooling/package.json
COPY --from=production /opt/i18n-tooling/node_modules /opt/i18n-tooling/node_modules
COPY --from=production /opt/i18n-tooling/packages/eslint-plugin-i18n/package.json /opt/i18n-tooling/packages/eslint-plugin-i18n/package.json
COPY --from=production /opt/i18n-tooling/packages/eslint-plugin-i18n/dist /opt/i18n-tooling/packages/eslint-plugin-i18n/dist
COPY --from=production /opt/i18n-tooling/packages/eslint-plugin-i18n/node_modules /opt/i18n-tooling/packages/eslint-plugin-i18n/node_modules
COPY --from=production /opt/i18n-tooling/packages/i18n-pipeline/package.json /opt/i18n-tooling/packages/i18n-pipeline/package.json
COPY --from=production /opt/i18n-tooling/packages/i18n-pipeline/dist /opt/i18n-tooling/packages/i18n-pipeline/dist
COPY --from=production /opt/i18n-tooling/packages/i18n-pipeline/node_modules /opt/i18n-tooling/packages/i18n-pipeline/node_modules
COPY LICENSE /licenses/LICENSE
RUN rm /tmp/node22.passed /tmp/node24.passed \
    && ln -s /opt/i18n-tooling/packages/i18n-pipeline/dist/cli.js /usr/local/bin/i18n-pipeline \
    && ln -s /opt/i18n-tooling/packages/i18n-pipeline/dist/cli.js /usr/local/bin/frontend-i18n
USER 1001
# Prove the production install can load the lint stack: a zero-config consumer
# with one valid message must pass in error mode, and a configured consumer
# must load the catalog rule from the i18n ESLint plugin.
RUN mkdir -p /tmp/smoke/src \
    && printf '{"dependencies":{"react-intl":"7.0.0"}}' > /tmp/smoke/package.json \
    && printf 'import { defineMessages } from "react-intl";\nexport default defineMessages({ items: { id: "items", defaultMessage: "{count, plural, one {# item} other {# items}}" } });\n' > /tmp/smoke/src/messages.ts \
    && i18n-pipeline validate-ci --root /tmp/smoke --results-dir /tmp/smoke-results --mode error \
    && test "$(cat /tmp/smoke-results/I18N_STATUS)" = pass \
    && test "$(cat /tmp/smoke-results/I18N_CONFIG)" = zero-config \
    && frontend-i18n validate-ci --root /tmp/smoke --results-dir /tmp/smoke-results --mode error \
    && test "$(cat /tmp/smoke-results/I18N_STATUS)" = pass \
    && test "$(cat /tmp/smoke-results/I18N_CONFIG)" = zero-config \
    && mkdir -p /tmp/smoke/i18n /tmp/smoke/locales \
    && printf '{"items":{"defaultMessage":"{count, plural, one {# item} other {# items}}"}}' > /tmp/smoke/locales/en.json \
    && printf '{"version":1,"checks":[{"source":{"path":"locales/en.json","adapter":"formatjs-json","locale":"en"},"targets":[]}],"sourceLint":{"catalog":"locales/en.json"}}' > /tmp/smoke/i18n/catalog-validation.json \
    && i18n-pipeline validate-ci --root /tmp/smoke --results-dir /tmp/smoke-results --mode error \
    && test "$(cat /tmp/smoke-results/I18N_CONFIG)" = config \
    && test "$(cat /tmp/smoke-results/I18N_ERRORS)" = 0 \
    && rm -rf /tmp/smoke /tmp/smoke-results
ENTRYPOINT ["i18n-pipeline"]
