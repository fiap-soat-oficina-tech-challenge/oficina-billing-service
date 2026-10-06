FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./

# npm ci para build determinístico; --ignore-scripts bloqueia scripts de
# instalação de dependências de terceiros (hardening de supply chain).
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=builder /app/dist ./dist

# New Relic: só configuração não sensível. A license key chega em runtime
# (Secret no Kubernetes, .env no docker compose). O agente nasce desligado e só
# liga quando o ambiente pede (ConfigMap no cluster).
ENV NEW_RELIC_ENABLED=false \
    NEW_RELIC_NO_CONFIG_FILE=true \
    NEW_RELIC_LOG=stdout \
    NEW_RELIC_LOG_LEVEL=warn \
    NEW_RELIC_APPLICATION_LOGGING_FORWARDING_ENABLED=false \
    NEW_RELIC_APPLICATION_LOGGING_LOCAL_DECORATING_ENABLED=false

RUN chown -R node:node /app
USER node

EXPOSE 3000

# `node` direto, em forma exec: o Node vira PID 1 e recebe o SIGTERM do
# Kubernetes, o stdout fica 100% JSON e `-r newrelic` carrega o agente antes da
# aplicação, como no OS Service.
CMD ["node", "-r", "newrelic", "dist/main.js"]
