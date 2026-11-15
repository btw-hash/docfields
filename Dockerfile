FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3470
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public
COPY samples ./samples
COPY evals ./evals
USER node
EXPOSE 3470
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3470/api/health || exit 1
CMD ["node", "dist/server.js"]
