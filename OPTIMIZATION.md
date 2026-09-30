# alist-encrypt 优化说明

本仓库基于上游 [zhanghoa/alist-encrypt](https://github.com/zhanghoa/alist-encrypt)，
做了 **bug 修复 + 性能优化**。

> ### 兼容性红线
> **所有改动均不改变密钥派生方式与密文格式，网上已存在的旧加密文件无需任何处理，
> 照常播放/下载/解密。**
> 这一点由 `test/compat.test.mjs` 的 **81 个黄金向量**（由未修改的上游实现生成密文指纹）
> 逐字节断言保证，每处修改后都必须全绿。

---

## 一、Bug 修复

| # | 问题 | 影响 |
|---|---|---|
| 1 | `pathToRegexp(new RegExp(p))` 生成**未锚定**正则，且 `*` 被当成正则量词 | `/backup/movie_encrypt_old/x.mp4` 被 `movie_encrypt/*` 误命中，文件被意外加解密 |
| 2 | `httpClient` 用 `result += chunk` 字符串累加响应体 | Buffer 隐式 `toString()`，PROPFIND 等多字节/二进制响应**损坏**；且无上限有 OOM 风险 |
| 2 | 上游请求 error 只打日志不 reject | Promise 永不落地，客户端请求**挂到超时** |
| 2 | `statusCode % 300 < 5` 判断重定向 | 600~604 等状态码被误判为 3xx |
| 3 | `cacheFileInfo` 不 await，靠 `sleep(100)` / `sleep(50)` 猜 | 低配设备/大目录时缓存未落地 → 无法判断文件/目录 → **404** |
| 4 | `datastore.remove(key)` 传字符串而非查询对象 | 过期数据**从未被删除** |
| 4 | `setValue` 的 `console.log` 打印 value | **用户密码、token 被打进日志** |
| 4 | 未创建 `conf/nedb` 目录 | 首次启动写库直接 **ENOENT 崩溃** |
| 4 | nedb 无索引，`findOne` 全表线性扫描 | 每个请求多次查询，缓存达万级时成主要瓶颈 |
| 5 | `globalHandle` 的 `env` 写死 `'dev'` | 生产环境也返回 `err.message`（信息泄露） |
| 5 | 登录接口 `console.log(username, password)` | **明文密码入日志**；且无防爆破 |
| 5 | `convertFile` 监听 `readStream 'end'` 就 `renameSync` | writeStream 尚未 flush → 移动**不完整文件** |
| 5 | `JSON.parse(respBody)` 无保护 | 后端返回 HTML 错误页即抛异常 |
| 7 | PROPFIND 响应用字符串 replace 改写 `<D:href>` | 命名空间前缀写死 `D:`，群晖/ES/rclone/macOS 前缀不同 → **显示加密乱码名** |

## 二、性能优化

实测环境：Cortex-A55 ×4（NAS/电视盒级 ARM），Node 22。

| 项目 | 优化前 | 优化后 | 提升 |
|---|---|---|---|
| ChaCha20 流式加密 | 4.5 MB/s | 123 MB/s | **29×** |
| ChaCha20 seek（1GB 拖到第 600MB） | O(n) 空跑 | O(1) 直接算 IV | 显著（原方式 2376ms） |
| 1000 文件目录列表 name 处理 | 891 ms | 87 ms | **10×** |
| `encodeName` | 196 µs | 27.8 µs | 7.1× |
| `decodeName` | 97 µs | 13.4 µs | 7.3× |
| `getPassWdOutward`（pbkdf2 1000轮） | 812 µs | 2.33 µs | **349×** |
| `pathFindPasswd` 正则匹配 | 2.66 µs | 0.31 µs | 8.6× |

主要手段：
- **原生 ChaCha20**：IV 布局为 `counter(4字节小端) || nonce(12字节)`，支持 O(1) seek；
  无法使用原生时自动回退纯 JS
- **MixBase64 实例缓存**：构造需 sha256 + KSA 洗牌，按 passwd 复用
- **pbkdf2 记忆化**：结果只取决于 `(password, encType)`，每个密码只算一次
  （原本每个请求都同步阻塞事件循环跑 1000 轮）
- **正则预编译**：不再每次请求重编译，且消除了 `path-to-regexp` 依赖
- **nedb 索引**：`key` 上建唯一索引，O(n) → O(log n)

## 三、工程化

- Dockerfile：`node:gallium-alpine`(Node 16, EOL) → Node 22 LTS 多阶段构建；
  非 root 用户；新增 `HEALTHCHECK` / `.dockerignore`
- 依赖：`ts-node`/`typescript` 等归入 devDependencies；移除已停更的 `pkg`
- 移除 `path-to-regexp` 依赖（改用零依赖的 `src/utils/pathMatcher.js`）
- 新增测试套件：122 个用例，覆盖兼容性红线与各修复点

## 四、使用方式

```bash
cd node-proxy
npm i
npm test          # 122 个用例，含旧格式兼容性红线
npm run build     # webpack 构建
```

### 可选开关（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `USE_STRUCTURED_XML` | `0` | 设为 `1` 启用结构化 XML 改写（修复 #7），默认保持旧行为以便灰度 |
| `CHA_CHA20_NATIVE` | `1` | 设为 `0` 回退到纯 JS ChaCha20，便于排查 |
| `RUN_MODE` | `prod` | 设为 `DEV` 时错误响应才返回详细 message |
| `HTTP_CLIENT_MAX_BUFFER` | 64MB | httpClient 响应体上限 |
| `UPSTREAM_TIMEOUT_MS` | 120000 | 上游请求超时 |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MS` | 10 / 5min | 登录失败限速 |
| `NEDB_CLEANUP_INTERVAL` | 5min | 过期数据清理间隔 |

## 五、验证

```bash
npm test                      # 全部用例
npm run golden                # 重新生成黄金向量（需上游原始实现）
npm run freeze-upstream <path># 冻结上游实现作为兼容性参照
```
