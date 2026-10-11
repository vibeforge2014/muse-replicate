import { describe, expect, test } from "vitest";
import { encodeWsFrame, OP_BINARY, WsFrameParser } from "@mas/sandbox";

/** ws-frame：k8s exec WS 传输的帧编解码（RFC 6455 子集）。 */
describe("ws-frame codec", () => {
  test("掩码/非掩码往返：各种长度档位（0/5/125/126/70000）", () => {
    for (const size of [0, 5, 125, 126, 70000]) {
      const payload = Buffer.alloc(size, 0);
      for (let i = 0; i < size; i++) payload[i] = (i * 7 + 3) & 0xff;
      for (const mask of [true, false]) {
        const wire = encodeWsFrame(OP_BINARY, payload, mask);
        const frames = new WsFrameParser().push(wire);
        expect(frames).toHaveLength(1);
        expect(frames[0]!.opcode).toBe(OP_BINARY);
        expect(frames[0]!.payload.equals(payload)).toBe(true);
      }
    }
  });

  test("流式解析：任意切分（单字节喂入 + 两帧粘包）", () => {
    const a = encodeWsFrame(OP_BINARY, Buffer.from("hello channel"), true);
    const b = encodeWsFrame(OP_BINARY, Buffer.alloc(200, 9), false);
    const glued = Buffer.concat([a, b]);
    const parser = new WsFrameParser();
    const out = [];
    for (let i = 0; i < glued.length; i++) out.push(...parser.push(glued.subarray(i, i + 1)));
    expect(out).toHaveLength(2);
    expect(out[0]!.payload.equals(Buffer.from("hello channel"))).toBe(true);
    expect(out[1]!.payload.length).toBe(200);
  });

  test("客户端帧的掩码确实生效（与裸负载不同）", () => {
    const payload = Buffer.from("must-be-masked");
    const wire = encodeWsFrame(OP_BINARY, payload, true);
    expect(wire.subarray(-payload.length).equals(payload)).toBe(false);
  });
});
