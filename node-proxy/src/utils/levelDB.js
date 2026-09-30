import Datastore from 'nedb-promises'
import { logger } from '@/common/logger'
import fs from 'fs'
import path from 'path'

// let datastore = Datastore.create('/path/to/db.db')
/**
 * 封装新方法
 *
 * 本轮修复(#4):
 *  1) 建立 key 索引 —— 上游无索引，findOne 是全表线性扫描；每个 WebDAV 请求会
 *     多次查询文件信息，缓存到万级时是主要瓶颈。加索引后 O(n) -> O(log n)。
 *  2) getValue 里 this.datastore.remove(key) 传的是**字符串**，nedb 的 remove
 *     需要查询对象，这个调用从不生效（过期数据永远删不掉）-> 改为 remove({key})。
 *  3) findOne 返回 null 时解构 const {expire,value} = null 会抛错，上游靠 try/catch
 *     当作流程控制 -> 改为显式判空。
 *  4) setValue/setExpire 里的 console.log 会把**用户密码、token** 打进日志/标准输出
 *     -> 移除敏感打印，改为 debug 级别且不输出 value。
 *  5) 30 秒一次的全表扫描清理（find({}) 拉全部文档）-> 改为带 expire 条件的批量删除，
 *     避免每隔 30 秒把整个库读进内存。
 */

// 清理间隔（毫秒），可用环境变量调整
const CLEANUP_INTERVAL = parseInt(process.env.NEDB_CLEANUP_INTERVAL || '', 10) || 5 * 60 * 1000

class Nedb {
  constructor(dbFile) {
    this.datastore = Datastore.create(dbFile)
    this.datastore.ensureIndex({ fieldName: 'key', unique: true })
    this.cleanupHandle = null
  }

  async load() {
    await this.datastore.load()
  }

  // 新增过期设置
  async setValue(key, value) {
    await this.datastore.removeMany({ key })
    await this.datastore.insert({ key, expire: -1, value })
  }

  async setExpire(key, value, second = 6 * 10) {
    await this.datastore.removeMany({ key })
    const expire = Date.now() + second * 1000
    await this.datastore.insert({ key, expire, value })
  }

  async getValue(key) {
    if (key === null || key === undefined) return null
    // key 可能是对象调用（历史代码 getAllFileInfo 传过对象），保持兼容
    const query = typeof key === 'object' && key !== null ? key : { key }
    let doc = null
    try {
      doc = await this.datastore.findOne(query)
    } catch (e) {
      logger.debug('@@getValue error', e?.message)
      return null
    }
    // 显式判空，不再依赖"解构 null 抛异常"来控制流程
    if (!doc) return null
    const { expire, value } = doc
    // 没有限制时间
    if (expire < 0) {
      return value
    }
    if (expire && expire > Date.now()) {
      return value
    }
    // 已过期：删除。修正参数类型（上游传字符串导致删除从不生效）
    try {
      await this.datastore.remove({ key: doc.key })
    } catch (e) {
      logger.debug('@@remove expired key error', e?.message)
    }
    return null
  }

  /** 按 expire 条件批量清理过期数据，避免全表 find({}) */
  async cleanExpired() {
    try {
      const n = await this.datastore.remove({ expire: { $gt: 0, $lt: Date.now() } }, { multi: true })
      if (n) logger.debug('@@cleanExpired removed', n)
      return n
    } catch (e) {
      logger.debug('@@cleanExpired error', e?.message)
      return 0
    }
  }

  startCleanup() {
    if (this.cleanupHandle) return
    this.cleanupHandle = setInterval(() => {
      this.cleanExpired()
    }, CLEANUP_INTERVAL)
    // 不阻止进程退出
    if (this.cleanupHandle.unref) this.cleanupHandle.unref()
  }

  stopCleanup() {
    if (this.cleanupHandle) {
      clearInterval(this.cleanupHandle)
      this.cleanupHandle = null
    }
  }
}

// 修复(#4 附带): 上游没有创建 conf/nedb 目录，首次安装/换目录启动时 nedb 写文件会
// 直接 ENOENT 崩溃。这里保证目录存在。
function ensureDbDir(dbFile) {
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  } catch (e) {
    logger.error('@@无法创建数据库目录', dbFile, e?.message)
  }
}

const dbFile = process.cwd() + '/conf/nedb/datafile'
ensureDbDir(dbFile)

const nedb = new Nedb(dbFile)

// 定时清除过期的数据（默认 5 分钟一次，且用条件删除代替全表扫描）
nedb.startCleanup()

export default nedb
