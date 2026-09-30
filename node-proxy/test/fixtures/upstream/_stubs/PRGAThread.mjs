// frozen stub: 原 PRGAThread 用 worker 线程计算 RC4 快进，此处用等价同步实现
export default async function PRGAExcuteThread(data) {
  let { sbox: S, i, j, position } = data
  for (let k = 0; k < position; k++) {
    i = (i + 1) % 256
    j = (j + S[i]) % 256
    const temp = S[i]
    S[i] = S[j]
    S[j] = temp
  }
  return { sbox: S, i, j }
}
