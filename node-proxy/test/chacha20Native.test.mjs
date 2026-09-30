import { describe, test, expect } from 'vitest'
import crypto from 'crypto'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import ChaCha20 from '@/utils/chaCha20'
import JsChaCha20 from './fixtures/upstream/chaCha20.mjs'

/**
 * ChaCha20 原生替换的正确性与性能验证
 * 核心红线: 原生实现的输出必须与**冻结的上游纯JS实现**逐字节一致，
 * 否则用户已加密的旧文件将无法解密。
 */
const MB = 1024 * 1024
const key = crypto.createHash('sha256').update('test-key').digest()
const nonce = crypto.createHash('md5').update('salt123').digest().subarray(0, 12)

describe('ChaCha20 原生替换', () => {
  test('与上游纯JS密钥流逐字节一致', () => {
    for (const len of [1, 63, 64, 65, 127, 128, 4096, 65537]) {
      const data = crypto.randomBytes(len)
      const js = Buffer.from(new JsChaCha20(key, nonce, 1).update(new Uint8Array(data)))
      const nat = Buffer.from(new ChaCha20(key, nonce, 1).update(Buffer.from(data)))
      expect(nat.equals(js), `长度 ${len} 不一致`).toBe(true)
    }
  })

  test('seek 到任意位置后密钥流与上游一致(O(1) seek)', () => {
    const positions = [0, 1, 63, 64, 100, 4096, 600 * MB, 1023 * MB]
    for (const pos of positions) {
      const data = crypto.randomBytes(128)
      const js = new JsChaCha20(key, nonce, 1)
      js.setPosition(pos)
      const want = Buffer.from(js.update(new Uint8Array(data)))

      const nat = new ChaCha20(key, nonce, 1)
      nat.setPosition(pos)
      const got = Buffer.from(nat.update(Buffer.from(data)))
      expect(got.equals(want), `seek ${pos} 不一致`).toBe(true)
    }
  })

  test('分块流式处理与整体处理一致(模拟真实下载分块)', () => {
    const size = 512 * 1024
    const data = crypto.randomBytes(size)
    const want = Buffer.from(new JsChaCha20(key, nonce, 1).update(new Uint8Array(data)))

    const c = new ChaCha20(key, nonce, 1)
    const chunks = []
    const step = 64 * 1024
    for (let i = 0; i < size; i += step) chunks.push(c.encrypt(Buffer.from(data.subarray(i, i + step))))
    expect(Buffer.concat(chunks).equals(want)).toBe(true)
  })

  test('密码(string)构造方式与上游等价', () => {
    const pw = '123456'
    const size = 4096
    const data = crypto.randomBytes(size)
    const a = Buffer.from(new JsChaCha20(pw, size).encrypt(Buffer.from(data)))
    const b = Buffer.from(new ChaCha20(pw, size).encrypt(Buffer.from(data)))
    expect(b.equals(a)).toBe(true)
  })

  test('吞吐: 原生应显著快于纯JS', async () => {
    const size = 16 * MB
    const data = crypto.randomBytes(size)
    const step = 64 * 1024
    const run = (inst) => {
      const t = performance.now()
      for (let i = 0; i < size; i += step) inst.encrypt(Buffer.from(data.subarray(i, i + step)))
      return size / MB / ((performance.now() - t) / 1000)
    }
    const jsMbps = run(new JsChaCha20(key, nonce, 1))
    const natMbps = run(new ChaCha20(key, nonce, 1))
    console.log(`  chacha20: 纯JS ${jsMbps.toFixed(1)} MB/s -> 原生 ${natMbps.toFixed(1)} MB/s  (${(natMbps / jsMbps).toFixed(0)}x)`)
    expect(natMbps).toBeGreaterThan(jsMbps)
  })

  test('Transform 流管道可用(真实加解密链路)', async () => {
    const { Readable, Writable } = await import('stream')
    const size = 256 * 1024
    const plain = crypto.randomBytes(size)
    const encipher = new ChaCha20(key, nonce, 1).encryptTransform()
    const decipher = new ChaCha20(key, nonce, 1).decryptTransform()
    const out = []
    const sink = new Writable({
      write(chunk, enc, cb) {
        out.push(chunk)
        cb()
      },
    })
    await pipeline(Readable.from([plain]), encipher, decipher, sink)
    expect(Buffer.concat(out).equals(plain)).toBe(true)
  })
})
