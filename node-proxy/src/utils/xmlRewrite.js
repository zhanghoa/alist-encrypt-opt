'use strict'
/**
 * PROPFIND 响应的结构化改写（修复 #7）
 *
 * 上游实现用**字符串 replace** 改写 WebDAV PROPFIND 响应：
 *   respBody.replace(`/${hrefName}${endsWith}</D:href>`, ...)
 *   respBody.replace(`${displayname}</D:displayname>`, ...)
 *
 * 该做法的致命问题：
 *   1) 命名空间前缀写死为 `D:` —— 群晖、ES文件浏览器、rclone、macOS Finder 各自的
 *      前缀不同（有的无前缀、有的是 `d:` 小写），前缀一变就替换失效，
 *      客户端会看到**加密后的乱码文件名**（这正是多处 "显示 orig_xxx" 的成因之一）；
 *   2) 逐文件对整个大字符串做 replace —— O(文件数 × 响应长度)，大目录开销可观；
 *   3) 字符串替换可能误伤正文内容相同的其他字段。
 *
 * 本模块改为：解析 XML -> 改写 displayname/href 字段 -> 重新序列化。
 *
 * 安全策略：默认仍走字符串替换（保持与现有行为完全一致），通过环境变量
 *   USE_STRUCTURED_XML=1
 * 开启结构化改写。这样即使某个客户端有特殊情况，也能一键回退。
 */

import { XMLParser, XMLBuilder } from 'fast-xml-parser'

// 保持与原 parser 一致的解析选项
const parseOpts = {
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
}

const buildOpts = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // 保留原有的命名空间声明，避免序列化后客户端解析失败
  suppressEmptyNode: false,
  format: false,
}

/**
 * 结构化改写 PROPFIND / PROPPATCH 响应中的文件名。
 *
 * @param {string} xml         原始响应体
 * @param {(rawName:string, isDir:boolean)=>string|null} renameFn
 *        输入真实文件名，返回要展示的名字；返回 null 表示不改写此项。
 * @returns {string} 改写后的 XML；解析失败时原样返回。
 */
export function rewriteXmlNames(xml, renameFn) {
  if (!xml || typeof xml !== 'string') return xml
  if (xml.indexOf('multistatus') === -1) return xml

  const parser = new XMLParser(parseOpts)
  let obj
  try {
    obj = parser.parse(xml)
  } catch (e) {
    // 解析失败：绝不改写，原样透传，避免比字符串替换更糟
    return xml
  }
  if (!obj || !obj.multistatus) return xml

  const responses = obj.multistatus.response
  if (!responses) return xml
  const list = Array.isArray(responses) ? responses : [responses]

  let changed = false
  for (const resp of list) {
    if (!resp) continue
    const href = resp.href
    const isDir = isDirectory(resp)
    const rawName = href == null ? null : decodeURIComponent(String(href).split('/').filter(Boolean).pop() || '')
    if (!rawName) continue

    const shown = renameFn(rawName, isDir)
    if (shown == null || shown === rawName) continue

    changed = true
    // 1) href：替换最后一段
    const prefixSeg = String(href).split('/')
    prefixSeg[prefixSeg.length - 1] = encodeURIComponent(shown)
    resp.href = prefixSeg.join('/')

    // 2) displayname（若存在）
    applyToDisplayName(resp, shown)
  }

  if (!changed) return xml

  try {
    return new XMLBuilder(buildOpts).build(obj)
  } catch {
    // 序列化失败：保守起见原样返回
    return xml
  }
}

function applyToDisplayName(resp, shown) {
  const set = (ps) => {
    if (!ps || !ps.prop) return
    if (typeof ps.prop.displayname === 'string' || ps.prop.displayname !== undefined) {
      ps.prop.displayname = shown
    }
  }
  if (Array.isArray(resp.propstat)) resp.propstat.forEach(set)
  else set(resp.propstat)
}

/** 判断该 response 项是目录还是文件 */
function isDirectory(resp) {
  const ps = Array.isArray(resp.propstat) ? resp.propstat[0] : resp.propstat
  const prop = ps && ps.prop
  if (!prop) return false
  // resourcetype 含 collection 表示目录
  if (prop.resourcetype && prop.resourcetype.collection !== undefined) return true
  const len = prop.getcontentlength
  return len === undefined || Number(len) === 0
}

/** 是否启用结构化改写 */
export function useStructuredXml() {
  return process.env.USE_STRUCTURED_XML === '1'
}
