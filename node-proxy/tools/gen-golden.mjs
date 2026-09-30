#!/usr/bin/env node
/**
 * 生成"黄金向量"(golden vectors)：冻结的上游实现在固定输入下的密文指纹。
 *
 * 这些指纹代表**互联网上已经存在的旧加密文件**的唯一正确解码方式。
 * 任何后续修改（bug 修复 / 性能优化）都必须能复现完全相同的指纹，
 * 否则意味着用户的旧文件将无法解密 —— 这是本项目不可逾越的红线。
 *
 * 用法: node tools/gen-golden.mjs
 * 输出: test/fixtures/golden.json
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import AesCTR from '../test/fixtures/upstream/aesCTR.mjs'
import Rc4Md5 from '../test/fixtures/upstream/rc4Md5.mjs'
import ChaCha20 from '../test/fixtures/upstream/chaCha20.mjs'
import MixBase64 from '../test/fixtures/upstream/mixBase64.mjs'
import FlowEnc from '../test/fixtures/upstream/flowEnc.mjs'

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

// 覆盖典型场景: 4KB小文件 / 1MB中文件 / 跨RC4的100万字节分段边界 / 精确128字节
const SIZES = [1, 127, 128, 4096, 65536, 999999, 1000000, 1000001, 1048576]
const PASSWORDS = ['123456', 'a'.repeat(32), '中文密码 Español 🔐']
const TYPES = ['aesctr', 'rc4', 'chacha20']

async function main() {
  const out = { _generated: new Date().toISOString(), _source: 'upstream @ conscious clone', vectors: [] }

  for (const password of PASSWORDS) {
    for (const type of TYPES) {
      for (const size of SIZES) {
        // 用固定伪随机内容填充，保证可复现
        const data = crypto.createHash('sha512').update(`seed:${type}:${size}`).digest()
          .subarray(0, 64).toString('hex').repeat(Math.ceil(size / 128) || 1)
        const plain = Buffer.from(data.slice(0, size))

        const enc = new FlowEnc(password, type, size)
        const encOut = Buffer.concat([Buffer.from(plain)])
        // FlowEnc 不直接暴露 encrypt(buffer), 取 encryptFlow
        const cipher = new (enc.encryptFlow.constructor)(password, size)
        const encrypted = Buffer.from(cipher.encrypt(Buffer.from(plain)))

        // 再建一个全新实例解密，必须还原明文
        // 上游流式密码: encrypt === decrypt (同一 XOR); FlowEnc 对外暴露 decryptTransform
        const cipher2 = new (cipher.constructor)(password, size)
        const decrypted = Buffer.from(cipher2.encrypt(Buffer.from(encrypted)))

        out.vectors.push({
          // 注意: 不用真实 password 明文入库，避免测试仓库携带凭据错觉
          passwordLen: password.length,
          passwordType: password.length === 32 ? 'hex32' : password === '123456' ? 'simple' : 'unicode',
          type,
          size,
          plainSha: sha256(plain),
          cipherSha: sha256(encrypted),
          roundtrip: sha256(decrypted) === sha256(plain),
        })
      }
    }
  }

  // 名字加密(MixBase64 + CRC6)黄金向量
  const NAMES = ['a.txt', '电影第1集.mp4', 'Hello World.pdf', '中文名字带空格 末集.mkv', 'x'.repeat(120)]
  const mixVectors = []
  {
    const passwdOutward = crypto.pbkdf2Sync('123456', 'AES-CTR', 1000, 16, 'sha256').toString('hex')
    const mix = new MixBase64(passwdOutward)
    for (const n of NAMES) {
      const e = mix.encode(n)
      const back = mix.decode(e).toString('utf8')
      mixVectors.push({ name: n.slice(0, 40), nameLen: n.length, enc: e, roundtrip: back === n })
    }
  }
  // FlowEnc.getPassWdOutward (passwdOutward 派生) 必须与 Upstream 完全一致
  const outward = {}
  for (const t of TYPES) outward[t] = FlowEnc.getPassWdOutward('123456', t)

  out.mixBase64 = mixVectors
  out.passwdOutward = outward
  fs.writeFileSync(path.resolve('test/fixtures/golden.json'), JSON.stringify(out, null, 2))
  console.log('已生成 %d 个加密向量, %d 个名字向量', out.vectors.length, mixVectors.length)
  const bad = out.vectors.filter((v) => !v.roundtrip)
  const badN = mixVectors.filter((v) => !v.roundtrip)
  console.log('roundtrip 失败:', bad.length, '| 名字 roundtrip 失败:', badN.length)
  if (bad.length || badN.length) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
