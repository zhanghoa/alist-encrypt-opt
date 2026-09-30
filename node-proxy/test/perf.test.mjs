import { describe, test, expect } from 'vitest'
import crypto from 'crypto'
import { pathFindPasswd, encodeName, decodeName } from '@/utils/commonUtil'
import MixBase64 from '@/utils/mixBase64'
import UpstreamMixBase64 from './fixtures/upstream/mixBase64.mjs'
import FlowEnc from '@/utils/flowEnc'

/**
 * 性能回归测试：确保优化确实生效，且输出与上游完全一致。
 */
const pw = '123456'
const outward = crypto.pbkdf2Sync(pw, 'AES-CTR', 1000, 16, 'sha256').toString('hex')

// 基准工具：累加并消费结果，防止 JIT 把只调用不使用的 fn 整体优化掉
// （会出现 0.2µs 这种不可能的数字）
function timeIt(fn, iters) {
  let sink = 0
  let acc = ''
  const t = performance.now()
  for (let i = 0; i < iters; i++) {
    const r = fn()
    if (typeof r === 'string') acc += r.length
    else sink += 1
  }
  const el = (performance.now() - t) / iters
  if (acc.length === 0 && sink === 0) throw new Error('benchmark consumed nothing')
  globalThis.__benchSink = (globalThis.__benchSink || 0) + acc.length + sink
  return el
}

describe('性能优化效果', () => {
  test('MixBase64.getShared 与每次 new 输出完全一致', () => {
    const names = ['a.txt', '电影第1集.mp4', 'Hello World.pdf', 'x'.repeat(120), '测试.mp4']
    for (const n of names) {
      const a = new MixBase64(outward).encode(n)
      const b = MixBase64.getShared(outward).encode(n)
      expect(b).toBe(a)
      expect(MixBase64.getShared(outward).decode(a).toString('utf8')).toBe(n)
    }
  })

  test('共享实例 encode 快于每次 new', () => {
    const iters = 3000
    const slow = timeIt(() => new UpstreamMixBase64(outward).encode('电影第1集.mp4'), iters)
    const fast = timeIt(() => MixBase64.getShared(outward).encode('电影第1集.mp4'), iters)
    console.log(`  encode: 每次new ${(slow*1000).toFixed(1)}µs -> 共享实例 ${(fast*1000).toFixed(2)}µs  (${(slow / fast).toFixed(1)}x)`)
    expect(fast).toBeLessThan(slow)
  })

  test('共享实例 decode 快于每次 new', () => {
    const enc = MixBase64.getShared(outward).encode('电影第1集.mp4')
    const iters = 3000
    const slow = timeIt(() => new UpstreamMixBase64(outward).decode(enc), iters)
    const fast = timeIt(() => MixBase64.getShared(outward).decode(enc), iters)
    console.log(`  decode: 每次new ${(slow*1000).toFixed(1)}µs -> 共享实例 ${(fast*1000).toFixed(2)}µs  (${(slow / fast).toFixed(1)}x)`)
    expect(fast).toBeLessThan(slow)
  })

  test('getPassWdOutward 命中缓存后显著变快且结果一致', () => {
    const expectOut = FlowEnc.getPassWdOutward(pw, 'aesctr')
    const slow = timeIt(() => {
      // 冷缓存模拟：直接走 pbkdf2
      crypto.pbkdf2Sync(pw, 'AES-CTR', 1000, 16, 'sha256').toString('hex')
    }, 300)
    const fast = timeIt(() => FlowEnc.getPassWdOutward(pw, 'aesctr'), 300)
    // slow/fast 都是 ms/次
    console.log(`  getPassWdOutward: pbkdf2 ${(slow * 1000).toFixed(1)}µs -> 缓存 ${(fast * 1000).toFixed(2)}µs  (${(slow / fast).toFixed(0)}x)`)
    expect(FlowEnc.getPassWdOutward(pw, 'aesctr')).toBe(expectOut)
    // 缓存命中必须快于冷计算（pbkdf2 1000 轮）
    expect(fast).toBeLessThan(slow)
  })

  test('目录列表场景端到端：1000 文件', () => {
    const passwdList = [
      { id: '1', enable: true, password: pw, encType: 'aesctr', encName: true, encFolder: false, encPath: ['movie_encrypt/*'] },
    ]
    const files = Array.from({ length: 1000 }, (_, i) => `/dav/aliyun/movie_encrypt/movie/剧集第${i}集.mp4`)
    const doList = () => {
      for (const f of files) {
        pathFindPasswd(passwdList, f)
        encodeName(pw, 'aesctr', '剧集第1集.mp4')
      }
    }
    doList() // warm
    const t = performance.now()
    doList()
    const ms = performance.now() - t
    console.log(`  1000 文件列表 name 处理: ${ms.toFixed(1)}ms`)
    // 优化后应远快于实测的 ~891ms
    expect(ms).toBeLessThan(891)
  })

  test('encodeName/decodeName 往返稳定', () => {
    const cases = ['a.txt', '电影第1集.mp4', 'Hello World.pdf', '中文名字带空格 末集.mkv']
    for (const n of cases) {
      expect(decodeName(pw, 'aesctr', encodeName(pw, 'aesctr', n))).toBe(n)
      expect(decodeName(pw, 'rc4', encodeName(pw, 'rc4', n))).toBe(n)
      expect(decodeName(pw, 'chacha20', encodeName(pw, 'chacha20', n))).toBe(n)
    }
  })
})
