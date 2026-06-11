# Production image for the ChampSet backend (Fastify + Mastra agent runner).
# Runs the HTTP API, the populate/enrich workflows, and the refresh scheduler.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
# Container has no routable IPv6; disable Happy-Eyeballs so Node fetch
# reaches OpenRouter / external pages. (Same fix as dev.)
ENV NODE_OPTIONS=--no-network-family-autoselection
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3501
CMD ["node", "dist/index.js"]
