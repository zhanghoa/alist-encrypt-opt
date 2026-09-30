# ============================================================
# 修复(#9/#10) Dockerfile 现代化
#  - 上游 node:gallium-alpine = Node 16，已 EOL 且无安全更新 -> Node 22 LTS
#  - 以 root 运行 -> 新增 node 用户降权
#  - 无 HEALTHCHECK -> 新增
#  - 多余 RUN pwd / RUN ls 层 -> 移除
#  - 上游 ENTRYPOINT 用 index.js，但 webpack 输出为 dist/index.js -> 修正路径
# ============================================================
# 构建阶段：依赖安装与运行分离
FROM node:22-alpine AS builder
WORKDIR /build
COPY node-proxy/package*.json ./
RUN npm i --omit=dev --no-audit --no-fund

# 运行阶段
FROM node:22-alpine AS runtime

# 时区（使用 tzdata 软链，避免上游 rm -rf /etc/localtime 的脆弱写法）
RUN apk add --no-cache tzdata \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && apk del tzdata

WORKDIR /node-proxy

# 只拷贝运行期依赖与构建产物
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
COPY node-proxy/dist ./dist
COPY node-proxy/public ./public

# 非 root 运行
RUN chown -R node:node /node-proxy
USER node

# 默认环境变量（可用 docker run -e 覆盖）
# 注意：USE_STRUCTURED_XML 默认 0，保持与旧版一致的行为；验证稳定后可设 1(修复 #7)
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    RUN_MODE=prod \
    USE_STRUCTURED_XML=0

EXPOSE 5344

# 健康检查：管理页面可达即视为健康
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:5344/public/index.html',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
