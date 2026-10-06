import { errInvalid } from "./errors.js";

/**
 * 不透明分页游标：base64url 的 {k: 键值(seq 或 id), d: 方向}（spec §11.1）。
 * 篡改的游标返回 400（GEN-08）。
 */
export interface Cursor {
  k: string;
  d: "asc" | "desc";
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw errInvalid("invalid page cursor");
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as Cursor).k === "string" &&
    ((parsed as Cursor).d === "asc" || (parsed as Cursor).d === "desc")
  ) {
    return parsed as Cursor;
  }
  throw errInvalid("invalid page cursor");
}
