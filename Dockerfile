FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages packages
COPY apps apps
COPY tsconfig.base.json vitest.config.ts ./
RUN pnpm install --no-frozen-lockfile
EXPOSE 8080
CMD ["npx", "tsx", "apps/server/src/main.ts"]
