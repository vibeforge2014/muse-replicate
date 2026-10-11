# runtime 基础镜像：server / worker / egress-proxy 共用（command 覆盖）
FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages packages
COPY apps apps
COPY tsconfig.base.json vitest.config.ts ./
RUN pnpm install --no-frozen-lockfile
EXPOSE 8080
CMD ["npx", "tsx", "apps/server/src/main.ts"]

# 沙箱镜像：runtime + codex CLI（driver 进沙箱，spec §8.4——
# codex app-server 在沙箱 Pod 内运行，经 pods/exec 接 stdio）。
# 版本钉住与 worker 的 codex-image@ 版本指纹对应（MAS_K8S_SANDBOX_IMAGE）。
FROM runtime AS sandbox
ARG CODEX_VERSION=latest
RUN npm install -g @openai/codex@${CODEX_VERSION}
