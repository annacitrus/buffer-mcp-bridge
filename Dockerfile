ARG NODE_IMAGE=node:24.22.3-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node config ./config
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/readyz',{headers:{host:new URL(process.env.PUBLIC_URL).host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
