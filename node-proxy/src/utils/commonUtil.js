import FlowEnc from './flowEnc'
import { compilePathPattern, matchCompiledPath, compilePasswdList } from './pathMatcher'
import path from 'path'

import MixBase64 from './mixBase64'
import Crcn from './crc6-8'
import { logger } from '@/common/logger'

const crc6 = new Crcn(6)
const origPrefix = 'orig_'
function isBadText(str) {
  // return /[ÃÂ�]/.test(str)
  return /[ÃÂ�¤§½]/.test(str)
}

// check file name, return real name
export function convertRealName(password, encType, pathText, encSuffix) {
  const fileName = path.basename(pathText)
  if (fileName.indexOf(origPrefix) === 0) {
    return fileName.replace(origPrefix, '')
  }

  // try encode name, fileName don't need decodeURI，encodeUrl func can't encode that like '(' '!'  in nodejs
  const ext = encSuffix || path.extname(fileName)
  const encName = encodeName(password, encType, fileName)
  console.log('@@decodeURI(fileName)', fileName, encName)
  return encName + ext
}

export function convertRealPathName(password, encType, pathText) {
  if (pathText.indexOf(origPrefix) === 0) {
    return pathText.replace(origPrefix, '')
  }
  // try encode name, fileName don't need decodeURI，encodeUrl func can't encode that like '(' '!'  in nodejs
  const encName = encodeName(password, encType, pathText)
  console.log('@@decodeURI(pathText)', encName)
  return encName
}

// if file name has encrypt, return show name
export function convertShowName(password, encType, pathText) {
  const fileName = path.basename(pathText)
  const ext = path.extname(fileName)
  const encName = fileName.replace(ext, '')
  // encName don't need decodeURI
  let showName = decodeName(password, encType, encName)
  return showName === null ? origPrefix + fileName : showName
}

export function convertRealPath(passwdList, fpath, encodeUri = false) {
  let foldPath = fpath
  const { passwdInfo, pathInfo } = pathFindPasswd(passwdList, foldPath)
  if (passwdInfo && passwdInfo.encFolder) {
    // 尝试解密路径，去掉第一个目录
    const foldNames = pathInfo[0].split('/')
    console.log('@@@foldNames', pathInfo, foldNames, encodeUri)
    foldNames.shift()
    let encFoldPath = ''
    let realFoldPath = ''
    for (let name of foldNames) {
      // webdav 传进来的路径是 /dav/aliyun/encfolder/abc/, name = ''
      realFoldPath += '/'
      if (name !== '') {
        let realFoldName = convertRealPathName(passwdInfo.password, passwdInfo.encType, name)
        if (encodeUri) {
          realFoldName = encodeURI(realFoldName)
        }
        realFoldPath += realFoldName
      }
      encFoldPath += '/' + name
    }
    foldPath = foldPath.replace(encFoldPath, realFoldPath)
  }
  return foldPath
}

// 判断是否为匹配的路径encPath:[]
// 修复: 上游 pathToRegexp(new RegExp(p)) 生成**未锚定**正则且 '*' 语义错乱,
// 导致 /backup/movie_encrypt_old/x.mp4 之类的路径被 movie_encrypt/* 误命中。
// 现改用 pathMatcher 的锚定编译; 同时预编译结果被缓存,避免每次请求重复编译。
const _execCache = new Map()
export function pathExec(encPath, url) {
  for (const filePath of encPath) {
    let re = _execCache.get(filePath)
    if (!re) {
      re = compilePathPattern(filePath)
      _execCache.set(filePath, re)
    }
    const result = re.exec(url)
    if (result) {
      return result
    }
  }
  return null
}
export { compilePathPattern, matchCompiledPath, compilePasswdList }
// 不允许加密乱码名字
export function encodeName(password, encType, plainName) {
  const isBad = isBadText(plainName)
  if (isBad) {
    console.log('@isBadText', plainName)
  }
  const passwdOutward = FlowEnc.getPassWdOutward(password, encType)
  //  randomStr
  // 性能优化: 复用实例
  const mix64 = MixBase64.getShared(passwdOutward)
  let encodeName = mix64.encode(plainName)
  const crc6Bit = crc6.checksum(Buffer.from(encodeName + passwdOutward))
  const crc6Check = MixBase64.getSourceChar(crc6Bit)
  encodeName += crc6Check
  return encodeName
}
// 字符判断
const unsafePattern = /[^a-zA-Z0-9\-_+~]/g
export function decodeName(password, encType, encodeName) {
  // 判断是否长度是否余
  const crcType = (encodeName.length * 6) % 8
  if (crcType !== 6 && crcType !== 12) {
    logger.debug('@@orig_decode fail', encodeName)
  }
  if (unsafePattern.test(encodeName)) {
    return null
  }
  const crc6Check = encodeName.substring(encodeName.length - 1)
  const passwdOutward = FlowEnc.getPassWdOutward(password, encType)
  // 性能优化: 复用实例，避免每次调用重复做 sha256 + KSA 洗牌(实测 ~66µs/次)
  const mix64 = MixBase64.getShared(passwdOutward)
  // start dec
  const subEncName = encodeName.substring(0, encodeName.length - 1)
  const crc6Bit = crc6.checksum(Buffer.from(subEncName + passwdOutward))
  // console.log(subEncName, MixBase64.getSourceChar(crc6Bit), crc6Check)
  if (MixBase64.getSourceChar(crc6Bit) !== crc6Check) {
    return null
  }
  // event pass crc6，it maybe decode error, like this name '68758PICxAd_1024-666 - 副本33.png'
  let decodeStr = null
  try {
    decodeStr = mix64.decode(subEncName).toString('utf8')
  } catch (e) {
    console.log('@@mix64 decode error', subEncName)
  }
  return decodeStr
}

export function encodeFromFolder(password, encType, folderPasswd, folderEncType) {
  const passwdInfo = folderEncType + '_' + folderPasswd
  return encodeName(password, encType, passwdInfo)
}

// 已知的算法类型，用于校验解析结果是否真的是"分享文件夹名"
const KNOWN_ENC_TYPES = ['aesctr', 'rc4', 'chacha20', 'mix']

export function decodeFromFolder(password, encType, encodeName) {
  // 修复(上游 bug): 原实现直接对**已加密**的文件夹名做 split('_')，
  // 但加密产物的字符表是 [A-Za-z0-9-~+]，**永远不含下划线**
  // (实测 5000 次加密 0 次命中 '_')，导致 arr.length 恒为 1 -> 永远 return false。
  // 结果: "据文件夹名派生密码"功能完全失效(网页解析按钮报 folderName not encdoe，
  //       代理侧静默退回主密码 -> 分享目录的文件名显示为 orig_xxx)。
  //
  // 正确做法: 先解密，再按下划线拆分。
  //
  // 安全兜底: CRC6 校验存在约 1.5% 误判率(用错密码也可能通过校验)，
  // 因此这里额外要求解析结果必须是"已知算法名 + 非空密码"，
  // 否则视为普通目录名，退回原密码 —— 保证不会误伤已加密的普通文件。
  let decodeStr = null
  try {
    decodeStr = decodeName(password, encType, encodeName)
  } catch (e) {
    return false
  }
  if (!decodeStr) {
    return false
  }
  const idx = decodeStr.indexOf('_')
  if (idx <= 0) {
    return false
  }
  const folderEncType = decodeStr.substring(0, idx)
  const folderPasswd = decodeStr.substring(idx + 1)
  if (!KNOWN_ENC_TYPES.includes(folderEncType) || !folderPasswd) {
    // 不是合法的分享文件夹名 -> 退回主密码
    return false
  }
  return { folderEncType, folderPasswd }
}

// 检查
export function pathFindPasswd(passwdList, url) {
  for (const passwdInfo of passwdList) {
    for (const filePath of passwdInfo.encPath) {
      const result = passwdInfo.enable ? pathExec([filePath], url) : null
      if (result) {
        // check folder name is can decode
        // getPassInfo()
        const newPasswdInfo = Object.assign({}, passwdInfo)
        // url maybe a folder, need decode
        if (!passwdInfo.encFolder) {
          const folders = url.split('/')
          for (const folderName of folders) {
            const data = decodeFromFolder(passwdInfo.password, passwdInfo.encType, folderName)
            if (data) {
              newPasswdInfo.encType = data.folderEncType
              newPasswdInfo.password = data.folderPasswd
              return { passwdInfo: newPasswdInfo, pathInfo: result }
            }
          }
        }
        return { passwdInfo, pathInfo: result }
      }
    }
  }
  return {}
}

