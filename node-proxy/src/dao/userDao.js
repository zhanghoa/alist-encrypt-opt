import levelDB from '../utils/levelDB'

export const userTable = 'userTable'

export async function initUserTable() {
  // const value = await levelDB.getValue(userTable)
  // if (value == null) {
  //   await levelDB.setValue(userTable, {})
  // }
}
// 获取用户信息
export async function getUserInfo(username) {
  const value = await levelDB.getValue(userTable)
  if (value == null) {
    return null
  }
  return value[username]
}

// 获取用户信息
export async function getUserByToken(token) {
  return levelDB.getValue(token)
}
// 缓存用户信息
export async function cacheUserToken(token, userInfo) {
  const value = await levelDB.setExpire(token, userInfo, 60 * 60 * 24)
  return value
}

export async function addUserInfo(userInfo) {
  const value = (await levelDB.getValue(userTable)) || {}
  value[userInfo.username] = userInfo
  await levelDB.setValue(userTable, value)
}

export async function updateUserInfo(userInfo) {
  const value = await levelDB.getValue(userTable)
  // 修复(#5): 上游在 value 为 null(用户表尚未初始化) 时直接 value[username] 会 TypeError
  if (value && value[userInfo.username]) {
    value[userInfo.username] = userInfo
    levelDB.setValue(userTable, value)
  }
}

export async function delectUserInfo(userInfo) {
  const value = await levelDB.getValue(userTable)
  if (value && value[userInfo.username]) {
    delete value[userInfo.username]
    await levelDB.setValue(userTable, value)
  }
}
