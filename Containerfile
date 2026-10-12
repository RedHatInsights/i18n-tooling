# Runtime image for `frontend-i18n validate-ci` in shared Konflux pipelines.
#
# The Node 22 and Node 24 stages run the repository test suite. The runtime
# stage copies a marker from each, so the image only exists if both pass.
ARG BUN_VERSION=1.3.14

FROM registry.access.redhat.com/ubi9/nodejs-22:1-1791442403@sha256:356d706b3f6bbed32e6b2c5009651d7d0d3dad506f6870c33860d88b44e5f53e AS node22
ARG BUN_VERSION
USER 0
RUN npm install --global "bun@${BUN_VERSION}"
WORKDIR /opt/i18n-tooling
COPY --chown=1001:0 . .
RUN chown 1001:0 /opt/i18n-tooling
USER 1001
# A clean install regenerates yarn.lock; both lockfiles must match the commit.
RUN sha256sum bun.lock yarn.lock > /tmp/lockfiles.sha256 \
    && bun install --frozen-lockfile \
    && sha256sum --check /tmp/lockfiles.sha256
RUN npm run typecheck \
    && npm run test:coverage \
    && npm run build \
    && npm run smoke:cli \
    && touch /tmp/node22.passed

FROM registry.access.redhat.com/ubi9/nodejs-24:1-1791219316@sha256:36af0bcb31021be93b0aab49e3ebcbbe07326496a550cface3294634fe7e6433 AS node24
ARG BUN_VERSION
USER 0
RUN npm install --global "bun@${BUN_VERSION}"
WORKDIR /opt/i18n-tooling
COPY --chown=1001:0 . .
RUN chown 1001:0 /opt/i18n-tooling
USER 1001
RUN bun install --frozen-lockfile
RUN npm run typecheck \
    && npm run test:coverage \
    && npm run build \
    && npm run smoke:cli \
    && touch /tmp/node24.passed

# Production dependencies only, from the same frozen lockfile.
FROM node22 AS production
RUN rm -rf node_modules packages/*/node_modules \
    && bun install --frozen-lockfile --production

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
    && ln -s /opt/i18n-tooling/packages/i18n-pipeline/dist/cli.js /usr/local/bin/frontend-i18n
USER 1001
# Prove the production install can load the lint stack: a zero-config consumer
# with one valid message must pass in error mode.
RUN mkdir -p /tmp/smoke/src \
    && printf '{"dependencies":{"react-intl":"7.0.0"}}' > /tmp/smoke/package.json \
    && printf 'import { defineMessages } from "react-intl";\nexport default defineMessages({ items: { id: "items", defaultMessage: "{count, plural, one {# item} other {# items}}" } });\n' > /tmp/smoke/src/messages.ts \
    && frontend-i18n validate-ci --root /tmp/smoke --results-dir /tmp/smoke-results --mode error \
    && test "$(cat /tmp/smoke-results/I18N_STATUS)" = pass \
    && test "$(cat /tmp/smoke-results/I18N_CONFIG)" = zero-config \
    && rm -rf /tmp/smoke /tmp/smoke-results
ENTRYPOINT ["frontend-i18n"]
