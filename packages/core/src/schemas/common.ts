import { z } from "zod";
import { errInvalid } from "../errors.js";

/** metadata：≤16 键，键 ≤64，值 ≤512 字符串（GEN-03）。 */
export const metadataSchema = z
  .record(z.string().max(64, "metadata key must be at most 64 characters"), z.string().max(512))
  .refine((m) => Object.keys(m).length <= 16, { message: "metadata must have at most 16 keys" });

export const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** created_at[gt|gte|lt|lte] 过滤参数（事件上比较的是 processed_at，spec §7.3）。 */
export const timeFilterKeys = ["gt", "gte", "lt", "lte"] as const;
export type TimeFilterKey = (typeof timeFilterKeys)[number];

export function parseTimeFilter(
  query: Record<string, unknown>,
): Partial<Record<TimeFilterKey, string>> {
  const out: Partial<Record<TimeFilterKey, string>> = {};
  for (const key of timeFilterKeys) {
    const v = query[`created_at[${key}]`];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !RFC3339_RE.test(v)) {
      throw errInvalid(`created_at[${key}] must be an RFC 3339 timestamp`);
    }
    out[key] = v;
  }
  return out;
}
