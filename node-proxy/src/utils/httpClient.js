import http from 'http'
import https from 'node:https'
import crypto, { randomUUID } from 'crypto'
import levelDB from './levelDB'
import path from 'path'
import { decodeName } from './commonUtil'
import { logger } from '@/common/logger'
// import { pathExec } from './commonUtil'
const Agent = http.Agent
const Agents = https.Agent

// httpClient 收集响应体的上限，防止后端异常大响应吃光内存（可由环境变量覆盖）
const MAX_BUFFER = parseInt(process.env.HTTP_CLIENT_MAX_BUFFER || '', 10) || 64 * 1024 * 1024
// 上游请求超时（毫秒）。流式下载需要更长超时，故默认给一个宽松值
const httpTimeoutMs = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '', 10) || 120 * 1000

// 默认maxFreeSockets=256
const httpsAgent = new Agents({ keepAlive: true })
const httpAgent = new Agent({ keepAlive: true })

export async function httpProxy(request, response, encryptTransform, decryptTransform) {
  const { method, headers, urlAddr, passwdInfo, url, fileSize } = request
  const reqId = randomUUID().substring(30)
  logger.debug('@@request_proxy: ', reqId, method, urlAddr, headers, !!encryptTransform, !!decryptTransform)
  // 创建请求
  const options = {
    method,
    headers,
    agent: ~urlAddr.indexOf('https') ? httpsAgent : httpAgent,
    rejectUnauthorized: false,
  }
  const httpRequest = ~urlAddr.indexOf('https') ? https : http
  return new Promise((resolve, reject) => {
    // 处理重定向的请求，让下载的流量经过代理服务器
    const httpReq = httpRequest.request(urlAddr, options, async (httpResp) => {
      logger.debug('@@statusCode', reqId, httpResp.statusCode, httpResp.headers)
      response.statusCode = httpResp.statusCode
      // 修复(#2): 上游用 statusCode % 300 < 5 判断重定向，
      // 该取模技巧会把 600~604、900~904 等状态码也误判为 3xx。改为显式区间判断。
      if (response.statusCode >= 300 && response.statusCode < 400) {
        // 可能出现304，redirectUrl = undefined
        const redirectUrl = httpResp.headers.location || '-'
        // 百度云盘不是https，坑爹，因为天翼云会多次302，所以这里要保持，跳转后的路径保持跟上次一致，经过本服务器代理就可以解密
        if (decryptTransform && passwdInfo.enable) {
          const key = crypto.randomUUID()
          await levelDB.setExpire(key, { redirectUrl, passwdInfo, fileSize }, 60 * 60 * 72) // 缓存起来，默认3天，足够下载和观看了
          // 、Referer
          httpResp.headers.location = `/redirect/${key}?decode=1&lastUrl=${encodeURIComponent(url)}`
        }
        logger.info('302 redirectUrl:', redirectUrl)
      } else if (httpResp.headers['content-range'] && httpResp.statusCode === 200) {
        response.statusCode = 206
      }
      // 不能用response.writeHead(statusCode, res.header),下面还有代码response.setHeader，不然会报错
      for (const key in httpResp.headers) {
        response.setHeader(key, httpResp.headers[key])
      }
      // 下载时解密文件名
      if (method === 'GET' && response.statusCode === 200 && passwdInfo && passwdInfo.encName) {
        let fileName = decodeURIComponent(path.basename(url))
        fileName = decodeName(passwdInfo.password, passwdInfo.encType, fileName.replace(path.extname(fileName), ''))
        if (fileName) {
          let cd = response.getHeader('content-disposition')
          cd = cd ? cd.replace(/filename\*?=[^=;]*;?/g, '') : ''
          logger.info('@@proxy解密文件名', reqId, fileName)
          response.setHeader('content-disposition', cd + `filename*=UTF-8''${encodeURIComponent(fileName)};`)
        }
      }

      httpResp
        .on('end', () => {
          // 这里好像会好一些，主动完成响应
          response.end()
          resolve()
        })
        .on('close', () => {
          logger.info('@远程响应关闭...', method, reqId, urlAddr)
          // response.destroy()
          if (decryptTransform) decryptTransform.destroy()
        })
      // 是否需要解密
      decryptTransform ? httpResp.pipe(decryptTransform).pipe(response) : httpResp.pipe(response)
    })
    httpReq.on('error', (err) => {
      logger.error('@@httpProxy request error ', reqId, err, urlAddr, headers)
      // 修复(#2): 上游此处仅打日志，Promise 不落地 -> 请求永久悬挂。
      // 这里显式结束响应并 resolve，保证 koa 链路得以收尾。
      try {
        if (!response.headersSent) {
          response.statusCode = 502
          response.end('Bad Gateway')
        } else {
          response.end()
        }
      } catch {}
      resolve()
    })
    // 上游请求也应设置超时，避免后端不响应时 socket 永久占用
    httpReq.setTimeout(httpTimeoutMs, () => {
      logger.error('@@httpProxy request timeout', reqId, urlAddr)
      httpReq.destroy(new Error('upstream timeout'))
    })
    // 是否需要加密
    encryptTransform ? request.pipe(encryptTransform).pipe(httpReq) : request.pipe(httpReq)
    // 重定向的请求 关闭时 关闭被重定向的请求
    response.on('close', () => {
      logger.debug('@本地响应关闭...', reqId, url)
      httpReq.destroy()
    })
  })
}

export async function httpClient(request, response) {
  // urlAddr 包含http
  const { method, headers, urlAddr, reqBody, url } = request
  // 请求reqBody已被篡改，由调用者调整length或删除，不然影响webdav
  // delete headers['content-length']
  logger.debug('@@request_client: ', method, urlAddr, headers, reqBody)
  // 创建请求
  const options = {
    method,
    headers,
    agent: ~urlAddr.indexOf('https') ? httpsAgent : httpAgent,
    rejectUnauthorized: false,
  }
  const httpRequest = ~urlAddr.indexOf('https') ? https : http
  return new Promise((resolve, reject) => {
    // 处理重定向的请求，让下载的流量经过代理服务器
    const httpReq = httpRequest.request(urlAddr, options, async (httpResp) => {
      logger.debug('@@statusCode', httpResp.statusCode, httpResp.headers)
      if (response) {
        // 外部的ctx.body=OK会导致statusCode=200，外部方法要执行ctx.status = ctx.res.statusCode
        response.statusCode = httpResp.statusCode
        for (const key in httpResp.headers) {
          response.setHeader(key, httpResp.headers[key])
        }
        // 不能用 response.writeHead(statusCode, res.header)
        // 会导致直接响应了Content-length: 123, 外部修改的body长度变化后就没法使用，而且外部需要要用ctx.body
        // 因为ctx.body 会重新计算响应的Content-length
      }
      let chunks = []
      let total = 0
      httpResp
        .on('data', (chunk) => {
          // 修复(#2): 上游用 result += chunk 做字符串拼接,会把 Buffer 隐式 toString(),
          // PROPFIND 等二进制/非 UTF8 响应会被损坏(乱码),且无大小上限有 OOM 风险。
          chunks.push(chunk)
          total += chunk.length
          if (total > MAX_BUFFER) {
            chunks = null
            httpResp.destroy()
            reject(new Error(`httpClient: 响应超过上限 ${MAX_BUFFER} 字节 ${url}`))
          }
        })
        .on('end', () => {
          const buf = chunks === null ? Buffer.alloc(0) : Buffer.concat(chunks, total)
          // 调用方普遍把返回值当字符串用(JSON.parse / parser.parse),
          // 这里一次性由 Buffer 转字符串,避免逐块隐式转换导致的多字节字符截断乱码
          resolve(buf.toString('utf8'))
          logger.info('httpClient响应结束.', method, total, url)
        })
        .on('error', (err) => {
          logger.error('@@httpClient response error ', err, url)
          reject(err)
        })
    })
    httpReq.on('error', (err) => {
      logger.error('@@httpClient request error ', err)
      // 修复(#2): 上游只打日志不 reject,Promise 永不落地,客户端请求一直挂到超时
      try {
        if (response && !response.headersSent) response.statusCode = 502
      } catch {}
      reject(err)
    })
    // check request type
    if (!reqBody) {
      url ? request.pipe(httpReq) : httpReq.end()
      return
    }
    // 发送请求
    typeof reqBody === 'string' ? httpReq.write(reqBody) : httpReq.write(JSON.stringify(reqBody))
    httpReq.end()
  })
}
