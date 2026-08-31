FROM node:20-alpine

WORKDIR /app
COPY vault ./vault
COPY scripts ./scripts
COPY package.json ./package.json

ENV NODE_ENV=production
ENV YITEC_VAULT_PORT=7979
ENV YITEC_VAULT_HOST=0.0.0.0
ENV PI_CODING_AGENT_DIR=/data/pi-agent

RUN mkdir -p /data/pi-agent/yitec

EXPOSE 7979
CMD ["node", "vault/server.js"]
