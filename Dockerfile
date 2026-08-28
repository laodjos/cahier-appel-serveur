FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

EXPOSE 4000

CMD ["sh", "-c", "node src/db/migrate.js && node src/db/creer-premier-compte.js && node src/server.js"]
