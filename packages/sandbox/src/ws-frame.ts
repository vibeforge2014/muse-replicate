import { randomBytes } from "node:crypto";

/**
 * 极简 WebSocket 帧编解码（RFC 6455 子集，binary 帧即可）：
 * 供 K8s pods/exec 的 v4.channel.k8s.io 子协议使用（k8s ≥1.24 服务端支持 WS exec）。
 * 客户端→服务端帧必须带掩码；服务端帧不带。
 */

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** 编一帧（mask=true 时按规范随机掩码逐字节异或）。 */
export function encodeWsFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1]! = mask ? 0x80 | len : len;
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[1]! = mask ? 0x80 | 126 : 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = mask ? 0x80 | 127 : 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0]! = 0x80 | opcode; // FIN + opcode
  if (!mask) return Buffer.concat([header, payload]);
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) {
    const byte = masked[i] ?? 0;
    const k = key[i & 3] ?? 0;
    masked[i] = byte ^ k;
  }
  return Buffer.concat([header, key, masked]);
}

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

/** 流式解析器：任意切分喂入，产出完整帧（不处理分片续帧——k8s 不用）。 */
export class WsFrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: WsFrame[] = [];
    for (;;) {
      const frame = this.tryParse();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  private tryParse(): WsFrame | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const b0 = b[0] ?? 0;
    const b1 = b[1] ?? 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    const len7 = b1 & 0x7f;
    let off = 2;
    let len: number;
    if (len7 < 126) {
      len = len7;
    } else if (len7 === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off);
      off += 2;
    } else {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ws frame too large");
      len = Number(big);
      off += 8;
    }
    const maskKey = masked ? b.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len) as Buffer<ArrayBuffer>;
    if (maskKey) {
      const un = Buffer.from(payload);
      for (let i = 0; i < un.length; i++) {
        const byte = un[i] ?? 0;
        const k = maskKey[i & 3] ?? 0;
        un[i] = byte ^ k;
      }
      payload = un;
    }
    this.buf = b.subarray(off + len);
    return { opcode, payload };
  }
}
