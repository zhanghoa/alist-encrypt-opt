import { describe, test, expect } from 'vitest'
import { encodeFromFolder, decodeFromFolder, encodeName, decodeName, pathFindPasswd } from '@/utils/commonUtil'

/**
 * decodeFromFolder 修复回归测试
 *
 * 上游 bug: 对**已加密**的文件夹名直接 split('_')，而加密产物字符表
 *          [A-Za-z0-9-~+] 不含下划线 -> 永远返回 false -> 功能完全失效。
 *
 * 修复: 先解密再拆分，并用"已知算法名 + 非空密码"做安全兜底。
 * 红线: 绝不能把普通文件名误判成分享文件夹（否则会选错密码）。
 */
describe('decodeFromFolder 修复', () => {
  const pw = '123456'

  test('能正确解析 encodeFromFolder 生成的分享文件夹名', () => {
    for (const [et, folderPw] of [['aesctr', 'mypass'], ['rc4', 'pass1'], ['chacha20', '中文密码'], ['aesctr', 'p@ss w0rd']]) {
      const name = encodeFromFolder(pw, 'aesctr', folderPw, et)
      const r = decodeFromFolder(pw, 'aesctr', name)
      expect(r, `${et}/${folderPw} 解析失败`).toBeTruthy()
      expect(r.folderEncType).toBe(et)
      expect(r.folderPasswd).toBe(folderPw)
    }
  })

  test('红线: 普通文件名绝不能被误判为分享文件夹(5000 例)', () => {
    let falseTrigger = 0
    for (let i = 0; i < 5000; i++) {
      const enc = encodeName(pw, 'aesctr', `电影第${i}集.mp4`)
      if (decodeFromFolder(pw, 'aesctr', enc) !== false) falseTrigger++
    }
    expect(falseTrigger).toBe(0)
  })

  test('红线: 含下划线前缀的普通名也不误判', () => {
    // 默认配置里 encPath 常含下划线(movie_encrypt / encrypt_folder)
    for (const s of ['movie_encrypt', 'encrypt_folder', 'my_movie', 'test_1']) {
      expect(decodeFromFolder(pw, 'aesctr', s)).toBe(false)
    }
  })

  test('非法/空输入安全返回 false，不抛异常', () => {
    for (const v of ['', 'abc', null, undefined, '_', 'aesctr_']) {
      expect(decodeFromFolder(pw, 'aesctr', v)).toBe(false)
    }
  })

  test('修复后端到端: 分享目录能自动换用派生密码', () => {
    const folderName = encodeFromFolder(pw, 'aesctr', 'mypass', 'aesctr')
    const list = [
      { id: '1', enable: true, password: pw, encType: 'aesctr', encName: true, encFolder: false, encPath: ['movie/*'] },
    ]
    const r = pathFindPasswd(list, `/movie/${folderName}/video.mp4`)
    expect(r.passwdInfo).toBeTruthy()
    // 修复前是 123456(主密码)，修复后应为分享的 mypass
    expect(r.passwdInfo.password).toBe('mypass')
    expect(r.passwdInfo.encType).toBe('aesctr')
  })

  test('非分享目录仍使用主密码(不回归)', () => {
    const list = [
      { id: '1', enable: true, password: pw, encType: 'aesctr', encName: true, encFolder: false, encPath: ['movie/*'] },
    ]
    const r = pathFindPasswd(list, '/movie/普通目录/video.mp4')
    expect(r.passwdInfo.password).toBe(pw)
  })

  test('encFolder=true 时不走该分支(不受影响)', () => {
    const list = [
      { id: '1', enable: true, password: pw, encType: 'aesctr', encName: true, encFolder: true, encPath: ['movie/*'] },
    ]
    const r = pathFindPasswd(list, '/movie/any/video.mp4')
    expect(r.passwdInfo.password).toBe(pw)
  })

  test('encodeName/decodeName 往返仍然正常(未受影响)', () => {
    for (const n of ['a.txt', '电影第1集.mp4', 'Hello World.pdf']) {
      expect(decodeName(pw, 'aesctr', encodeName(pw, 'aesctr', n))).toBe(n)
    }
  })
})
