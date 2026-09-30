#!/usr/bin/env node
/**
 * 冻结上游原始实现 -> test/fixtures/upstream/*.mjs
 *
 * 目的：把未修改的上游加密实现固化进本仓库，作为"旧文件格式"的唯一真相来源。
 * 后续所有性能优化都必须产出与这些冻结实现逐字节相同的密文，否则视为兼容性破坏。
 *
 * 用法: node tools/freeze-upstream.mjs <上游仓库路径>
 *  上游仓库: https://github.com/zhanghoa/alist-encrypt 的原始 clone
 */
import fs from 'fs'
import path from 'path'

const upstream = process.argv[2]
if (!upstream) {
  console.error('用法: node tools/freeze-upstream.mjs <上游alist-encrypt仓库路径>')
  process.exit(1)
}

const OUT = path.resolve('test/fixtures/upstream')
fs.mkdirSync(OUT, { recursive: true })

// 需要冻结的模块（相对 node-proxy/src/utils/ 或 src/）
const files = [
  'src/utils/aesCTR.js',
  'src/utils/rc4Md5.js',
  'src/utils/chaCha20.js',
  'src/utils/mixBase64.js',
  'src/utils/crc6-8.js',
  'src/utils/flowEnc.js',
  'src/utils/mixEnc.js',
  'src/utils/commonUtil.js',
]

// PRGAThread 会 spawn worker 线程；测试环境下用等价的纯计算替代（输出与 worker 一致）
const prgaStub = `// frozen stub: 原 PRGAThread 用 worker 线程计算 RC4 快进，此处用等价同步实现
export default async function PRGAExcuteThread(data) {
  let { sbox: S, i, j, position } = data
  for (let k = 0; k < position; k++) {
    i = (i + 1) % 256
    j = (j + S[i]) % 256
    const temp = S[i]
    S[i] = S[j]
    S[j] = temp
  }
  return { sbox: S, i, j }
}
`

function convert(src) {
  let s = fs.readFileSync(src, 'utf8')
  // alias '@/xxx' -> 相对'../'(本 fixtures 目录位于 test/fixtures/upstream)
  s = s.replace(/from '@\/common\/logger'/g, "from '../_stubs/logger.mjs'")
  s = s.replace(/from '@\/([^']+)'/g, "from './\$1.mjs'")
  // 相对导入补 .mjs: './xxx' -> './xxx.mjs'
  s = s.replace(/from '(\.\/[^']+?)'/g, (m, p) => (p.endsWith('.mjs') ? m : `from '${p}.mjs'`))
  return s
}

const loggerStub = `// frozen stub of src/common/logger.js (测试用，无 log4js 依赖)
export const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
`
fs.mkdirSync(path.join(OUT, '_stubs'), { recursive: true })
fs.writeFileSync(path.join(OUT, '_stubs/logger.mjs'), loggerStub)
fs.writeFileSync(path.join(OUT, '_stubs/PRGAThread.mjs'), prgaStub)

let n = 0
for (const rel of files) {
  const src = path.join(upstream, 'node-proxy', rel)
  if (!fs.existsSync(src)) {
    console.warn('  跳过(不存在):', rel)
    continue
  }
  const name = path.basename(rel, '.js') + '.mjs'
  let content = convert(src)
  // rc4Md5 引 './PRGAThread' -> 用 stub
  content = content.replace(/from '\.\/PRGAThread\.mjs'/g, "from './_stubs/PRGAThread.mjs'")
  fs.writeFileSync(path.join(OUT, name), content)
  n++
}
// pathToRegexp 依赖由仓库 node_modules 提供，无需冻结
console.log(`已冻结 ${n} 个上游模块 -> test/fixtures/upstream/`)
