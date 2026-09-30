import { test, describe, expect } from 'vitest'
import { rewriteXmlNames, useStructuredXml } from '@/utils/xmlRewrite'

/**
 * PROPFIND XML 结构化改写测试(#7)
 * 目标：解决上游字符串 replace 写死 `D:` 命名空间前缀，
 *       导致不同客户端(群晖/ES/rclone/macOS)看到原始加密名(orig_xxx)的问题。
 */
const mapping = {
  'enc_movie_file': '电影第一集.mp4',
  'enc_folder_name': '我的文件夹',
}

const renameFn = (raw) => mapping[raw] ?? null

describe('XML 文件名改写', () => {
  test('标准 D: 命名空间 -> 正确解密显示名', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/aliyun/enc_folder_name/</D:href>
    <D:propstat>
      <D:prop><D:displayname>enc_folder_name</D:displayname><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/aliyun/enc_folder_name/enc_movie_file</D:href>
    <D:propstat>
      <D:prop><D:displayname>enc_movie_file</D:displayname><D:getcontentlength>12345</D:getcontentlength></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`
    const out = rewriteXmlNames(xml, renameFn)
    expect(out).toContain('我的文件夹')
    expect(out).toContain('电影第一集.mp4')
    expect(out).not.toContain('enc_folder_name</')
    expect(out).not.toContain('>enc_movie_file<')
  })

  test('无命名空间前缀(群晖/某些客户端) -> 依然生效', () => {
    const xml = `<multistatus xmlns="DAV:">
      <response>
        <href>/dav/x/enc_movie_file</href>
        <propstat><prop><displayname>enc_movie_file</displayname><getcontentlength>99</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat>
      </response>
    </multistatus>`
    const out = rewriteXmlNames(xml, renameFn)
    expect(out).toContain('电影第一集.mp4')
  })

  test('小写 d: 前缀 -> 依然生效', () => {
    const xml = `<d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/x/enc_movie_file</d:href>
      <d:propstat><d:prop><d:displayname>enc_movie_file</d:displayname><d:getcontentlength>5</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
    </d:multistatus>`
    const out = rewriteXmlNames(xml, renameFn)
    expect(out).toContain('电影第一集.mp4')
  })

  test('非法 XML / 非 multistatus -> 原样返回不破坏', () => {
    expect(rewriteXmlNames('这不是XML<<<', renameFn)).toBe('这不是XML<<<')
    expect(rewriteXmlNames('', renameFn)).toBe('')
    expect(rewriteXmlNames(null, renameFn)).toBe(null)
    expect(rewriteXmlNames('<html>502 Bad Gateway</html>', renameFn)).toBe('<html>502 Bad Gateway</html>')
  })

  test('无需改写的条目保持原样(不引入差异)', () => {
    const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/dav/plain.mp4</href><propstat><prop><displayname>plain.mp4</displayname><getcontentlength>1</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`
    expect(rewriteXmlNames(xml, renameFn)).toBe(xml)
  })

  test('默认关闭结构化改写,可通过环境变量开启', () => {
    expect(typeof useStructuredXml()).toBe('boolean')
  })
})
