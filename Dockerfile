FROM node:24-bookworm-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production
CMD ["node", "server/index.mjs"]
