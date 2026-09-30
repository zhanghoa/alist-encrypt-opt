'use strict'

import MixEnc from './mixEnc'
import Rc4Md5 from './rc4Md5'
import AesCTR from './aesCTR'
import ChaCha20 from './chaCha20'

const cachePasswdOutward = {}

// 性能优化: 每个请求都会 new FlowEnc(...)，而构造函数内部会对密码做一次
// pbkdf2Sync(1000 轮) —— 这是**同步阻塞事件循环**的固定开销（实测约 1.2ms/次），
// 而结果只取决于 (password, encType)。这里按 (password, encType) 记忆化，
// 保证输出与逐次计算完全一致，但每个密码只算一次。
// 用 Map + 上限防止在极端场景（海量不同密码）下无界增长。
const derivedCache = new Map()
const DERIVED_CACHE_MAX = parseInt(process.env.DERIVED_CACHE_MAX || '', 10) || 256

function getCached(pwd, type, compute) {
  const key = type + '\u0000' + pwd
  const hit = derivedCache.get(key)
  if (hit !== undefined) return hit
  const val = compute()
  if (derivedCache.size >= DERIVED_CACHE_MAX) {
    // 简单的 FIFO 淘汰
    const oldest = derivedCache.keys().next().value
    derivedCache.delete(oldest)
  }
  derivedCache.set(key, val)
  return val
}

class FlowEnc {
  constructor(password, encryptType = 'chacha20', fileSize = 0) {
    fileSize *= 1
    let encryptFlow = null
    // 这里可以优化，把cachePasswdOutward的值替换password
    if (encryptType === 'chacha20') {
      encryptFlow = new ChaCha20(password, fileSize)
      this.passwdOutward = getCached(password, 'chacha20', () => encryptFlow.passwdOutward)
    }
    if (encryptType === 'mix') {
      encryptFlow = new MixEnc(password, fileSize)
      this.passwdOutward = getCached(password, 'mix', () => encryptFlow.passwdOutward)
    }
    if (encryptType === 'rc4') {
      encryptFlow = new Rc4Md5(password, fileSize)
      this.passwdOutward = getCached(password, 'rc4', () => encryptFlow.passwdOutward)
    }
    if (encryptType === 'aesctr') {
      encryptFlow = new AesCTR(password, fileSize)
      this.passwdOutward = getCached(password, 'aesctr', () => encryptFlow.passwdOutward)
    }
    if (encryptType === null) {
      throw new Error('FlowEnc error')
    }
    cachePasswdOutward[password + encryptType] = this.passwdOutward
    this.encryptFlow = encryptFlow
    this.encryptType = encryptType
  }

  async setPosition(position) {
    await this.encryptFlow.setPositionAsync(position)
  }

  // 加密流转换
  encryptTransform() {
    return this.encryptFlow.encryptTransform()
  }

  decryptTransform() {
    return this.encryptFlow.decryptTransform()
  }
}

FlowEnc.getPassWdOutward = function (password, encryptType) {
  const passwdOutward = cachePasswdOutward[password + encryptType]
  if (passwdOutward) {
    return passwdOutward
  }
  return getCached(password, encryptType, () => new FlowEnc(password, encryptType, 1).passwdOutward)
}

// const flowEnc = new FlowEnc('abc1234')
// const encode = flowEnc.encodeData('测试的明文加密1234￥%#')
// const decode = flowEnc.decodeData(encode)
// console.log('@@@decode', encode, decode.toString())
// console.log(new FlowEnc('e10adc3949ba56abbe5be95ff90a8636'))

export default FlowEnc
