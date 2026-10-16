// SSE 客户端：原生 EventSource 不支持自定义 header（Bearer 鉴权），用 fetch + ReadableStream 手写

import { getApiBase, getApiKey } from "./client";

export interface SseFrame {
  id: string;
  event: string;
  data: unknown;
}

export interface SseClient {
  close(): void;
}

export interface SseHandlers {
  onFrame: (f: SseFrame) => void;
  onError?: (e: Error) => void;
  onOpen?: () => void;
}

export function openSse(path: string, lastEventId: string | null, handlers: SseHandlers): SseClient {
  const key = getApiKey();
  if (!key) {
    handlers.onError?.(new Error("未设置 API Key"));
    return { close: () => {} };
  }

  const base = getApiBase();
  const url = (base || "") + path;
  const ctrl = new AbortController();
  let closed = false;

  const headers: Record<string, string> = {
    Accept: "text/event-stream",
    Authorization: `Bearer ${key}`,
  };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;

  (async () => {
    try {
      const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        handlers.onError?.(new Error(`SSE 连接失败 ${res.status}: ${text || res.statusText}`));
        return;
      }
      handlers.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE 帧以 \n\n 分隔
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!raw.trim()) continue;
          if (raw.startsWith(":")) continue; // 注释行（心跳）
          const frame = parseFrame(raw);
          if (frame) handlers.onFrame(frame);
        }
      }
    } catch (e: unknown) {
      if (!closed) handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  })();

  return {
    close() {
      closed = true;
      ctrl.abort();
    },
  };
}

function parseFrame(raw: string): SseFrame | null {
  let id = "";
  let event = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event && !data && !id) return null;
  let parsed: unknown = data;
  if (data) {
    try {
      parsed = JSON.parse(data);
    } catch {
      // 保持字符串
    }
  }
  return { id, event, data: parsed };
}
