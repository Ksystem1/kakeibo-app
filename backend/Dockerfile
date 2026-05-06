FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts

EXPOSE 3456
# npm を挟まず Node を PID 1 に近づけ、クラッシュ時のスタックと SIGTERM の伝播を分かりやすくする
CMD ["node", "src/index.js"]
