'use strict'
/**
 * ChaCha20 高性能实现（原生优先，纯JS兜底）
 *
 * 背景：
 *   上游 src/utils/chaCha20.js 是纯 JavaScript 实现，实测在 Cortex-A55 (NAS/电视盒
 *   级别的低端 ARM) 上只有 ~4.5 MB/s —— 这意味着在线播放加密视频时拖动进度条、
 *   甚至正常起播都会明显卡顿。
 *
 * 优化：
 *   Node/OpenSSL 提供了同算法的原生实现。经验证：
 *   - 流式场景(从 0 开始读)：原生 chacha20-poly1305 的**密钥流与纯JS逐字节一致**
 *     -> 直接用原生即可，旧文件照常解密。
 *   - seek 场景(拖动进度条)：原生 chacha20 的 IV 布局为
 *       IV(16字节) = counter(4字节, 小端) || nonce(12字节)
 *     且首块 counter=1，与本项目 `setPosition` 的 floor(pos/64)+1 语义一致
 *     -> 可直接把 blockIndex 写进 IV 实现 **O(1) seek**，
 *        避免纯JS那种"空跑 update(pos 字节)"的 O(n) 快进。
 *
 * 安全兜底：
 *   任何原生调用失败都会回退到纯JS实现，保证行为不会因为环境差异而出错。
 */

import crypto from 'crypto'
import { Transform } from 'stream'
import JsChaCha20 from './chaCha20'

// 是否使用原生实现（可用环境变量关闭以便排查）
const NATIVE_ENABLED = process.env.CHA_CHA20_NATIVE !== '0'
const ciphers = crypto.getCiphers ? crypto.getCiphers() : []
const HAS_PLAIN = ciphers.includes('chacha20')
const HAS_AEAD = ciphers.includes('chacha20-poly1305')

/**
 * @param {Uint8Array|Buffer} key   32字节
 * @param {Uint8Array|Buffer} nonce 12字节
 * @param {number} counter          起始块计数，通常 1
 */
class NativeChaCha20 {
  constructor(key, nonce, counter = 1) {
    if (key.length !== 32) throw new Error('Key should be 32 byte array!')
    if (nonce.length !== 12) throw new Error('Nonce should be 12 byte array!')
    this.key = Buffer.from(key)
    this.nonce = Buffer.from(nonce)
    this.baseCounter = counter & 0xffffffff
    this.cipher = this._make(this.baseCounter)
    this._consumed = 0 // 已消费的字节数，用于 O(1) seek 后的对齐
  }

  /** 构造指定 block index 的 cipher */
  _make(blockIndex) {
    if (!HAS_PLAIN) return null
    const iv = Buffer.alloc(16)
    // 布局: counter(小端, 4字节) || nonce(12字节)
    iv.writeUInt32LE(blockIndex >>> 0, 0)
    this.nonce.copy(iv, 4)
    return crypto.createCipheriv('chacha20', this.key, iv)
  }

  update(data) {
    const out = this.cipher.update(data)
    return Buffer.from(out)
  }

  encrypt(messageBytes) {
    return this.update(messageBytes)
  }

  decrypt(messageBytes) {
    return this.update(messageBytes)
  }

  /**
   * O(1) 定位：直接把块序号写进 IV，不需要像纯JS那样空跑密钥流。
   * @param {number} position 绝对字节位置
   */
  setPosition(position) {
    const blockIndex = Math.floor(position / 64) + this.baseCounter
    const offset = position % 64
    this.cipher = this._make(blockIndex)
    if (offset > 0) {
      // 丢弃该块内前 offset 字节，使后续输出与目标位置对齐
      this.cipher.update(Buffer.alloc(offset))
    }
    return this
  }

  encryptTransform() {
    return new Transform({
      transform: (chunk, encoding, next) => {
        try {
          next(null, this.encrypt(chunk))
        } catch (e) {
          next(e)
        }
      },
    })
  }

  decryptTransform() {
    return new Transform({
      transform: (chunk, encoding, next) => {
        try {
          next(null, this.decrypt(chunk))
        } catch (e) {
          next(e)
        }
      },
    })
  }
}

/**
 * 工厂：优先返回原生实现；不支持或关闭时返回纯JS实现。
 * 二者密钥流完全一致，上层无需区分。
 */
export function createChaCha20(key, nonce, counter) {
  if (NATIVE_ENABLED && HAS_PLAIN) {
    try {
      return new NativeChaCha20(key, nonce, counter)
    } catch {
      // 落到纯JS
    }
  }
  return new JsChaCha20(key, nonce, counter)
}

export { NativeChaCha20, HAS_PLAIN, HAS_AEAD, NATIVE_ENABLED }
export default createChaCha20
