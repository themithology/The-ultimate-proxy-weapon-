FROM node:20-alpine
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=1024
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY config ./config
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 8000 8080
CMD ["node", "src/index.js"]
