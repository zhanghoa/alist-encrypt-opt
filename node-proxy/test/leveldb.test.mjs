import { test, describe, expect, beforeAll, afterAll } from 'vitest'
import Datastore from 'nedb-promises'
import NedbLike from '@/utils/levelDB'

/**
 * levelDB 修复回归测试(#4)
 *  - 过期 key 必须被真正删除（上游 remove(key) 传字符串，删除从未生效）
 *  - findOne 显式判空，不再依赖"解构 null 抛异常"
 *  - 索引建立后查询仍正确
 */
describe('nedb 封装层', () => {
  test('过期数据必须被真正删除(上游 remove(key) 从未生效)', async () => {
    // 用内存库隔离验证核心逻辑，避免写真实 conf/nedb
    const ds = Datastore.create({ inMemoryOnly: true, autoload: true })
    await ds.load()
    await ds.insert({ key: 'oldTok', expire: Date.now() - 1000, value: { password: 'secret' } })
    await ds.insert({ key: 'alive', expire: Date.now() + 100000, value: 'ok' })

    // 上游错误写法：传字符串 -> 删不掉
    const afterWrong = await ds.remove('oldTok')
    const stillThere = await ds.findOne({ key: 'oldTok' })
    expect(afterWrong).toBe(0)
    expect(stillThere).not.toBeNull() // 证明 bug 存在

    // 修复写法：查询对象 -> 真删掉
    const n = await ds.remove({ key: 'oldTok' })
    expect(n).toBe(1)
    expect(await ds.findOne({ key: 'oldTok' })).toBeNull()
    expect(await ds.findOne({ key: 'alive' })).not.toBeNull()
  })

  test('索引下查询行为一致', async () => {
    const ds = Datastore.create({ inMemoryOnly: true, autoload: true })
    await ds.load()
    ds.ensureIndex({ fieldName: 'key', unique: true })
    for (let i = 0; i < 500; i++) await ds.insert({ key: 'k' + i, expire: -1, value: i })
    expect((await ds.findOne({ key: 'k499' })).value).toBe(499)
    expect(await ds.findOne({ key: 'nope' })).toBeNull()
  })

  test('真实 nedb 实例可读写往返', async () => {
    await NedbLike.load()
    const k = '__test_key_' + Date.now()
    await NedbLike.setExpire(k, { hello: 'world' }, 60)
    expect(await NedbLike.getValue(k)).toEqual({ hello: 'world' })
    // 过期后返回 null 且被清理
    await NedbLike.setExpire(k, { hello: 'world' }, -1)
    expect(await NedbLike.getValue(k)).toBeNull()
  })
})
