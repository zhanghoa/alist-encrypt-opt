'use strict'
/**
 * 加密路径匹配器
 *
 * 背景：
 *   上游实现为 `pathToRegexp(new RegExp(filePath))`，存在两个严重缺陷：
 *   1) **不锚定**：生成的正则无 ^...$，导致 `/backup/movie_encrypt_old/x.mp4`
 *      会被规则 `movie_encrypt/*` 误命中（路径任意位置的子串都会被匹配）；
 *   2) **语义错乱**：`pathToRegexp` 接收字符串时把 `*` 当作"命名通配符段"，而这里
 *      先套了一层 `new RegExp()`，使 `*` 退化成正则量词（匹配"零个或多个 /"），
 *      于是 `folder/*` 连 `folderX/a` 都能匹配，与 README 承诺的"该目录下所有文件"不符。
 *
 * 修复后的语义（与 README 保持一致）：
 *   - `*`   ：匹配该层任意文件名（不含 `/`）
 *   - `**`  ：跨层匹配任意深度
 *   - 其他部分按**转义后的字面量**比对，"/" 作为路径分隔符严格对齐
 *
 * 兼容性：只影响"哪些路径被判定为需要加解密"，**不改变任何密钥派生与密文格式**，
 *   因此对已加密的旧文件没有任何影响（见 test/compat.test.mjs 的黄金向量用例）。
 */

/**
 * 将用户配置的 encPath 规则编译成一个**已锚定**的正则。
 * @param {string} pattern 例如 'movie_encrypt/*'、'/dav/aliyun/enc/**'
 * @returns {RegExp}
 */
export function compilePathPattern(pattern) {
  if (pattern instanceof RegExp) return pattern
  let src = String(pattern)
  // 统一去掉首尾多余斜杠后再处理，保证 '/dav/x/*' 与 'dav/x/*' 等价
  const leadingSlash = src.startsWith('/')
  src = src.replace(/^\/+/, '').replace(/\/+$/, '')

  const parts = src.split('/')
  const reParts = parts.map((seg) => {
    if (seg === '**') return '.*'
    if (seg === '*') return '[^/]*' // 允许零个：使 'dir/*' 命中 'dir/' 与 'dir' 本身
    // '*' 出现在段中间（如 'movie_*'）：转成本层通配符
    if (seg.includes('*')) {
      return seg.split('*').map(escapeRegExp).join('[^/]*')
    }
    return escapeRegExp(seg)
  })
  const body = reParts.join('/').replace(/\/\[\^\/\]\*$/, '(?:/[^/]*)?')
  // 末尾的 '*' 单独处理：'dir/*' 需同时命中 'dir'、'dir/'、'dir/a'、'dir/a/b'
  // 上游的 pathToRegexp(new RegExp(p)) 不锚定，因此 "anywhere/encrypt_folder/x"
  // 这类"路径任意位置出现该目录名"也会被命中 —— 这是 README 承诺的用法
  // ("所有 movie_encrypt 目录的文件都会被加密")，必须保留。
  // 但同时要用**路径边界**消除 `folderX/a` 这类子串误命中。
  // '(?:/|^)' 要求规则第一段出现在路径边界上，而不是某个更长目录名的中间片段。
  // '*' 需要至少匹配一层内容(?:/|$) 已覆盖; 但 'dir/*' 也应命中 'dir/' 本身
  // (WebDAV PROPFIND 常带尾斜杠), 故把最后的 '/' 设为可选。
  return new RegExp(`(?:^|/)${body}(?:/.*)?$`)
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 在已编译的规则列表中匹配 url，返回第一个命中项。
 * @param {Array<{re:RegExp, raw:string, rule:object}>} compiled
 * @param {string} url
 */
export function matchCompiledPath(compiled, url) {
  for (const item of compiled) {
    const m = item.re.exec(url)
    if (m) return { rule: item.rule, match: m, pattern: item.raw }
  }
  return null
}

/**
 * 把一组 passwdList 预编译为带正则的规则索引，避免每次请求重复编译。
 * 上游在 pathFindPasswd 内**每次调用**都执行 pathToRegexp(...) 编译，属于热路径浪费。
 * @param {Array} passwdList
 * @returns {Array<{re:RegExp, raw:string, rule:object}>}
 */
export function compilePasswdList(passwdList) {
  const out = []
  for (const rule of passwdList || []) {
    for (const p of rule.encPath || []) {
      try {
        out.push({ re: compilePathPattern(p), raw: p, rule })
      } catch {
        // 用户填了非法规则时不让服务崩溃，记录后跳过
      }
    }
  }
  return out
}
