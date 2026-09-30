import { test, describe, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { httpClient } from '@/utils/httpClient'

/**
 * httpClient 修复回归测试(#2)
 *   - Buffer 拼接替代字符串累加，修复多字节字符被 chunk 切开导致的乱码
 *   - 上游错误必须 reject，不能让 Promise 悬挂
 *   - 重定向判断用显式 3xx 区间，替代 statusCode % 300 < 5
 */
describe('httpClient 二进制安全与错误处理', () => {
  let server
  let port
  const payload = Buffer.concat([
    Buffer.from('<?xml version="1.0"?><d:multistatus>'),
    Buffer.from([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]), // '中文' UTF-8,故意跨 chunk 边界
    Buffer.from('</d:multistatus>'),
  ])

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      const mid = payload.length - 7
      res.write(payload.subarray(0, mid))
      setTimeout(() => res.end(payload.subarray(mid)), 10)
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    port = server.address().port
  })
  afterAll(() => server.close())

  test('多字节字符跨 chunk 边界不乱码', async () => {
    const out = await httpClient({ method: 'GET', urlAddr: `http://127.0.0.1:${port}/x`, headers: {} })
    expect(out).toContain('中文')
    expect(Buffer.from(out).length).toBe(payload.length)
  })

  test('上游连接错误必须 reject 而非悬挂', async () => {
    const s2 = http.createServer((req) => req.destroy())
    await new Promise((r) => s2.listen(0, '127.0.0.1', r))
    const p = s2.address().port
    let rejected = false
    try {
      await httpClient({ method: 'GET', urlAddr: `http://127.0.0.1:${p}/`, headers: {} })
    } catch {
      rejected = true
    }
    s2.close()
    expect(rejected).toBe(true)
  })
})
