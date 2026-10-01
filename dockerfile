# ============================================================
# alist-encrypt 优化版 —— 多阶段构建，完全自包含
#
# 设计要点:
#   - 构建产物 dist/ 不在 git 仓库中，因此**必须在镜像内完成 webpack 构建**，
#     不能依赖宿主机预先构建（否则 CI/干净 clone 构建必然失败）
#   - node:22-alpine (上游 gallium=Node16 已 EOL)
#   - 非 root 运行 + HEALTHCHECK
#   - 运行阶段只保留运行期依赖，镜像体积最小化
# ============================================================

# ---------------- 阶段1: 构建（含 webpack 产物）----------------
FROM node:22-alpine AS builder
WORKDIR /build

# 先只复制依赖清单，充分利用 Docker 层缓存
COPY node-proxy/package.json node-proxy/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm i --no-audit --no-fund

# 复制源码并在镜像内完成构建
COPY node-proxy/ ./
RUN npm run build

# ---------------- 阶段2: 仅运行期依赖 ----------------
FROM node:22-alpine AS deps
WORKDIR /deps
COPY node-proxy/package.json node-proxy/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm i --omit=dev --no-audit --no-fund
RUN npm prune --omit=dev

# ---------------- 阶段3: 运行 ----------------
FROM node:22-alpine AS runtime

# 时区
RUN apk add --no-cache tzdata \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && apk del tzdata

WORKDIR /node-proxy

COPY --from=deps /deps/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/public ./public

# 非 root 运行（conf 目录建议由运行时挂载卷提供）
RUN chown -R node:node /node-proxy
USER node

# 默认环境变量（可用 docker run -e 覆盖）
# USE_STRUCTURED_XML 默认 0，保持与旧版一致；验证稳定后可设 1(修复 #7)
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    RUN_MODE=prod \
    USE_STRUCTURED_XML=0

EXPOSE 5344

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=30s \
  CMD node -e "require('http').get('http://127.0.0.1:5344/public/index.html',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
