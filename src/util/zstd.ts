import zlib from 'node:zlib';

type ZstdCapable = typeof zlib & { zstdDecompressSync?: (buf: Buffer) => Buffer };

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * 解压 zstd 数据。
 *
 * DSH 的会话日志（`session*.jsonl.zstd`）是**多帧拼接**的：每批事件各自一个 zstd 帧。
 * Node 的 `zstdDecompressSync` 只解第一帧，因此这里按魔数扫描逐帧解压再拼接。
 * 需要 Node ≥ 22（zstd 支持），更低版本给出可操作的报错。
 */
export function decompressZstd(buf: Buffer): Buffer {
  const zstd = (zlib as ZstdCapable).zstdDecompressSync;
  if (typeof zstd !== 'function') {
    throw new Error('当前 Node 不支持 zstd 解压（需要 Node ≥ 22）；请先手动解压为 .jsonl 再导入');
  }

  // 注意：对多帧输入 zstdDecompressSync 只解第一帧且**不报错**，
  // 因此不能走「先整段解码」的快路径，必须按魔数逐帧解压后拼接。
  const starts: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i);
    }
  }
  const chunks: Buffer[] = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      chunks.push(zstd(buf.subarray(start, end)));
    } catch {
      // 压缩数据里的伪魔数：跳过该片
    }
  }
  if (chunks.length === 0) throw new Error('zstd 解压失败：未找到可解压的帧');
  return Buffer.concat(chunks);
}
