FROM node:18.19-bullseye-slim AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

ENV PORT=4000
ENV DOCKER_SOCKET=/var/run/docker.sock
EXPOSE 4000

CMD ["node", "index.js"]
