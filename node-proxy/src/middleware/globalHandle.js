'use strict'

// 修复(#5): 上游把 env 写死成 'dev'，导致生产环境也把 err.message(含堆栈/路径细节)
// 返回给客户端 —— 属于信息泄露。改为读取环境变量，默认按生产处理。
const env = process.env.RUN_MODE || 'prod'

export default async function (ctx, next) {
  try {
    await next()
    // 兼容webdav中401的时候，body = ''
    if (!ctx.body) {
      return
    }
    // 参数转换, 转换成自己的数据格式
  } catch (err) {
    // 所有的异常都在 app 上触发一个 error 事件，框架会记录一条错误日志
    // app.emit('error', err, this);
    const status = err.status || 500
    // 生产环境时 500 错误的详细错误内容不返回给客户端，因为可能包含敏感信息
    const error = status === 500 && env !== 'DEV' ? 'Internal Server Error' : err.message
    console.error('@@err', err?.message || err)
    // 从 error 对象上读出各个属性，设置到响应中
    ctx.body = {
      success: false,
      message: error,
      code: status, // 服务端自身的处理逻辑错误(包含框架错误500 及 自定义业务逻辑错误533开始 ) 客户端请求参数导致的错误(4xx开始)，设置不同的状态码
      data: null,
    }
    // 406 是能让用户看到的错误，参数校验失败也不能让用户看到（一般不存在参数校验失败）
    // 注意：status 是数字，上游与字符串 '403' 比较导致该分支永远进不来 -> 改为数字比较
    if (status === 403 || status === 406) {
      ctx.body.message = error
    }
    ctx.status = 200
  }
}
