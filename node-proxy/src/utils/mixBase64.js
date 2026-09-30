'use strict'
import crypto from 'crypto'

const source = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-~+'

// use sha1 str to init
function initKSA(passwd) {
  let key = passwd
  if (typeof passwd === 'string') {
    key = crypto.createHash('sha256').update(passwd).digest()
  }
  const K = []
  // 对S表进行初始赋值
  const sbox = []
  const sourceKey = source.split('')
  //  对S表进行初始赋值
  for (let i = 0; i < source.length; i++) {
    sbox[i] = i
  }
  // 用种子密钥对K表进行填充
  for (let i = 0; i < source.length; i++) {
    K[i] = key[i % key.length]
  }
  // 对S表进行置换
  for (let i = 0, j = 0; i < source.length; i++) {
    j = (j + sbox[i] + K[i]) % source.length
    const temp = sbox[i]
    sbox[i] = sbox[j]
    sbox[j] = temp
  }
  let secret = ''
  for (const i of sbox) {
    secret += sourceKey[i]
  }
  return secret
}

// 自定义的base64加密
function MixBase64(passwd, salt = 'mix64') {
  // 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  const secret = passwd.length === 64 ? passwd : initKSA(passwd + salt)
  const chars = secret.split('')
  const mapChars = {}
  chars.forEach((e, index) => {
    mapChars[e] = index
  })
  this.chars = chars
  // 编码加密
  this.encode = function (bufferOrStr, encoding = 'utf-8') {
    const buffer = bufferOrStr instanceof Buffer ? bufferOrStr : Buffer.from(bufferOrStr, encoding)
    let result = ''
    let arr = []
    let bt = []
    let char
    for (let i = 0; i < buffer.length; i += 3) {
      if (i + 3 > buffer.length) {
        arr = buffer.subarray(i, buffer.length)
        break
      }
      bt = buffer.subarray(i, i + 3)
      char = chars[bt[0] >> 2] + chars[((bt[0] & 3) << 4) | (bt[1] >> 4)] + chars[((bt[1] & 15) << 2) | (bt[2] >> 6)] + chars[bt[2] & 63]
      result += char
    }
    if (buffer.length % 3 === 1) {
      char = chars[arr[0] >> 2] + chars[(arr[0] & 3) << 4] + chars[64] + chars[64]
      result += char
    } else if (buffer.length % 3 === 2) {
      char = chars[arr[0] >> 2] + chars[((arr[0] & 3) << 4) | (arr[1] >> 4)] + chars[(arr[1] & 15) << 2] + chars[64]
      result += char
    }
    return result
  }
  // 编码解密
  this.decode = function (base64Str) {
    let size = (base64Str.length / 4) * 3
    let j = 0
    if (~base64Str.indexOf(chars[64] + '' + chars[64])) {
      size -= 2
    } else if (~base64Str.indexOf(chars[64])) {
      size -= 1
    }
    const buffer = Buffer.alloc(size)
    let enc1
    let enc2
    let enc3
    let enc4
    let i = 0
    while (i < base64Str.length) {
      enc1 = mapChars[base64Str.charAt(i++)]
      enc2 = mapChars[base64Str.charAt(i++)]
      enc3 = mapChars[base64Str.charAt(i++)]
      enc4 = mapChars[base64Str.charAt(i++)]
      buffer.writeUInt8((enc1 << 2) | (enc2 >> 4), j++)
      if (enc3 !== 64) {
        buffer.writeUInt8(((enc2 & 15) << 4) | (enc3 >> 2), j++)
      }
      if (enc4 !== 64) {
        buffer.writeUInt8(((enc3 & 3) << 6) | enc4, j++)
      }
    }
    return buffer
  }
}

// 性能优化: new MixBase64(passwd) 要做一次 sha256 + 64 元素 KSA 洗牌 + split + 建映射表，
// 实测约 66µs/次；而 encodeName/decodeName 在目录列表路径上**每个文件每段都会 new 一次**。
// 实例本身只取决于 passwd，故按 passwd 缓存复用（实例内部无可变状态，线程/并发安全）。
const _instanceCache = new Map()
const INSTANCE_CACHE_MAX = parseInt(process.env.MIX_INSTANCE_CACHE_MAX || '', 10) || 128

MixBase64.getShared = function (passwd, salt) {
  const key = (salt === undefined ? '' : salt) + '\u0000' + passwd
  const hit = _instanceCache.get(key)
  if (hit) return hit
  const inst = salt === undefined ? new MixBase64(passwd) : new MixBase64(passwd, salt)
  if (_instanceCache.size >= INSTANCE_CACHE_MAX) {
    const oldest = _instanceCache.keys().next().value
    _instanceCache.delete(oldest)
  }
  _instanceCache.set(key, inst)
  return inst
}

MixBase64.sourceChars = source.split('')

// plaintext check bit
MixBase64.getCheckBit = function (text) {
  const bufferArr = Buffer.from(text)
  let count = 0
  for (const num of bufferArr) {
    count += num
  }
  count %= 64
  return MixBase64.sourceChars[count]
}

MixBase64.randomSecret = function () {
  // 不能使用 = 号，url穿参数不支持
  const source = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-~+'
  const chars = source.split('')
  const newChars = []
  while (chars.length > 0) {
    const index = Math.floor(Math.random() * chars.length)
    newChars.push(chars[index])
    chars.splice(index, 1)
  }
  return newChars.join('')
}

MixBase64.randomStr = function (length) {
  // 不能使用 = 号，url穿参数不支持
  const chars = source.split('')
  const newChars = []
  while (length-- > 0) {
    const index = Math.floor(Math.random() * chars.length)
    newChars.push(chars[index])
    chars.splice(index, 1)
  }
  return newChars.join('')
}

MixBase64.getSourceChar = function (index) {
  // 不能使用 = 号，url穿参数不支持
  return source.split('')[index]
}

MixBase64.initKSA = initKSA

export default MixBase64
// Buffer.from(str, 'base64').toString('base64') === str

// function test() {
//   const secret = '123456'
//   const mybase64 = new MixBase64(secret)
//   const test = 'test123456'
//   const encodeStr = mybase64.encode(test)
//   const bufferData = mybase64.decode(encodeStr)
//   const encodeFromBuffer = mybase64.encode(bufferData)
//   console.log(encodeStr, encodeFromBuffer, bufferData.toString())
// }
// test()
