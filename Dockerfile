FROM node:20-alpine as base
WORKDIR /usr/src/app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
