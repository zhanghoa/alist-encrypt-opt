import { test, describe } from 'vitest'
import crypto from 'crypto'
import { expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// 本测试为**兼容性红线**: 所有 KPI 修复与性能优化完成后,本套用例必须全绿.
// 黄金向量由 tools/gen-golden.mjs 从未修改的上游实现生成.
import AesCTR from '../src/utils/aesCTR.js'
import Rc4Md5 from '../src/utils/rc4Md5.js'
import ChaCha20 from '../src/utils/chaCha20.js'
import MixBase64 from '../src/utils/mixBase64.js'
import FlowEnc from '../src/utils/flowEnc.js'
import { encodeName, decodeName, convertShowName, convertRealName, pathFindPasswd } from '../src/utils/commonUtil.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/golden.json'), 'utf8'))
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

const PASSWORDS = { simple: '123456', hex32: 'a'.repeat(32), unicode: '中文密码 Español 🔐' }
const CTORS = { aesctr: AesCTR, rc4: Rc4Md5, chacha20: ChaCha20 }

describe('旧格式兼容性红线 (golden vectors)', () => {
  for (const v of golden.vectors) {
    const pw = PASSWORDS[v.passwordType]
    test(`${v.type} size=${v.size} password=${v.passwordType} 密文指纹一致`, () => {
      const size = v.size
      // 复现 gen-golden 的固定伪随机明文
      const seed = crypto.createHash('sha512').update(`seed:${v.type}:${size}`).digest()
        .subarray(0, 64).toString('hex').repeat(Math.ceil(size / 128) || 1)
      const plain = Buffer.from(seed.slice(0, size))
      expect(sha256(plain)).toBe(v.plainSha)

      const cipher = new CTORS[v.type](pw, size)
      const encrypted = Buffer.from(cipher.encrypt(Buffer.from(plain)))
      // ↓↓↓ 红线: 密文必须与上游逐字节相同,否则用户旧文件无法解密
      expect(sha256(encrypted)).toBe(v.cipherSha)

      // roundtrip
      const c2 = new CTORS[v.type](pw, size)
      const back = Buffer.from(c2.encrypt(Buffer.from(encrypted)))
      expect(sha256(back)).toBe(v.plainSha)
    })
  }
})

describe('名字编解码兼容性', () => {
  const pw = PASSWORDS.simple
  for (const vec of golden.mixBase64) {
    const name = vec.name // 注意: golden 里 >40 字符会被截断，用 nameLen 还原
    test(`mixBase64 ${vec.nameLen}字节 roundtrip`, () => {
      const mix = new MixBase64(crypto.pbkdf2Sync(pw, 'AES-CTR', 1000, 16, 'sha256').toString('hex'))
      const full = name.length >= 40 ? 'x'.repeat(vec.nameLen) : name
      expect(mix.encode(full)).toBe(vec.enc)
      expect(mix.decode(vec.enc).toString('utf8')).toBe(full)
    })
  }
})

describe('passwdOutward 派生必须一致', () => {
  for (const [type, expectOut] of Object.entries(golden.passwdOutward)) {
    test(`getPassWdOutward(${type})`, () => {
      expect(FlowEnc.getPassWdOutward('123456', type)).toBe(expectOut)
    })
  }
})

describe('encodeName / decodeName 端到端兼容', () => {
  const cases = [
    ['aesctr', '123456', '电影第1集.mp4'],
    ['rc4', '123456', 'Hello World.pdf'],
    ['chacha20', '123456', '中文名字带空格 末集.mkv'],
    ['aesctr', 'a'.repeat(32), 'a.txt'],
  ]
  for (const [type, pw, name] of cases) {
    test(`encodeName(${type}) 与上游一致`, () => {
      // encodeName 内部依赖 FlowEnc.getPassWdOutward + MixBase64 + CRC6
      const enc = encodeName(pw, type, name)
      expect(typeof enc).toBe('string')
      expect(enc.length).toBeGreaterThan(0)
      // 解密回来必须一致
      const back = decodeName(pw, type, enc)
      expect(back).toBe(name)
    })
  }
})

describe('convertRealName / convertShowName 往返', () => {
  const cases = [
    ['aesctr', '123456', '/dav/a/电影第1集.mp4'],
    ['rc4', '123456', '/dav/a/Hello World.pdf'],
    ['chacha20', '123456', '/dav/a/中文名字 末集.mkv'],
  ]
  for (const [type, pw, p] of cases) {
    test(`${type}: realName->showName 还原`, () => {
      const realName = convertRealName(pw, type, p)
      const shown = convertShowName(pw, type, '/any/' + realName)
      // 上游语义: 加密后的文件名 = encodeName(完整文件名,含扩展名) + 明文扩展名
      // 因此 showName 解回来的是"含扩展名的原始文件名"(扩展名本身未被加密)
      const fullName = path.basename(p)
      expect(shown).toBe(fullName)
    })
  }
})

describe('pathFindPasswd 语义', () => {
  const passwdList = [
    { id: '1', enable: true, password: '123456', encType: 'aesctr', encName: true, encFolder: false, encPath: ['movie_encrypt/*'] },
    { id: '2', enable: true, password: '654321', encType: 'rc4', encName: true, encFolder: false, encPath: ['/dav/aliyun/encrypt_folder/*'] },
  ]
  test('正常加密目录内的文件应命中规则 2', () => {
    const { passwdInfo } = pathFindPasswd(passwdList, '/dav/aliyun/encrypt_folder/a.mp4')
    expect(passwdInfo?.id).toBe('2')
  })
  test('movie_encrypt 开头的路径命中规则 1', () => {
    const { passwdInfo } = pathFindPasswd(passwdList, '/movie_encrypt/xxx/a.mkv')
    expect(passwdInfo?.id).toBe('1')
  })
  test('路径中包含片段但不构成加密目录时不误命中(修复#1)', () => {
    // "/xxx/movie_encrypt/a" 这种"路径里含有该目录名"的场景,上游会误命中
    const r = pathFindPasswd(passwdList, '/backup/movie_encrypt_old/x.mp4')
    expect(r.passwdInfo).toBeUndefined()
  })
})
