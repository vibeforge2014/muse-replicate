import { z } from "zod";

/** Memory Store / Memory / Version（plan M6 W11，test-case-plan 5.12 MEM-01~08）。 */

export const MEMORY_MAX_CONTENT_BYTES = 100 * 1024;
export const MEMORY_MAX_PATH_BYTES = 1024;

const encoder = new TextEncoder();

/** MEM-02：path 为斜杠分隔的相对路径；裸 `/`、空段、`.`、`..`、控制字符、超 1024 字节都非法。 */
export function memoryPathError(path: string): string | null {
  if (encoder.encode(path).length > MEMORY_MAX_PATH_BYTES) return "path exceeds 1024 bytes";
  if (path === "") return "path must not be empty";
  if (path.startsWith("/") || path.endsWith("/")) return "path must not start or end with '/'";
  for (const seg of path.split("/")) {
    if (seg === "") return "path must not contain empty segments";
    if (seg === "." || seg === "..") return `path segment '${seg}' is not allowed`;
    if (/[\x00-\x1F\x7F]/.test(seg)) return "path must not contain control characters";
  }
  return null;
}

export const memoryStoreCreateSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(1024).nullable().optional(),
  })
  .strict();

export const memoryUpsertSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().min(0),
    precondition: z
      .object({
        type: z.literal("content_sha256"),
        content_sha256: z.string().regex(/^[0-9a-f]{64}$/, "content_sha256 must be a 64-char hex string"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const pathErr = memoryPathError(m.path);
    if (pathErr) ctx.addIssue({ code: z.ZodIssueCode.custom, message: pathErr });
    if (encoder.encode(m.content).length > MEMORY_MAX_CONTENT_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `content exceeds ${MEMORY_MAX_CONTENT_BYTES} bytes` });
    }
  });

/** 挂载点固定为 /mnt/memory/<slug>（spec §19）；slug 由 name 归一化，workspace 内唯一。 */
export function slugifyMemoryStore(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "store";
}
