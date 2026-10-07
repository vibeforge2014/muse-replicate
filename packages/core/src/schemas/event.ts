import { z } from "zod";
import { errInvalid } from "../errors.js";

/** 对外事件类型全集（spec §12）。 */
export const EVENT_TYPES = [
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "agent.message",
  "agent.thinking",
  "agent.tool_use",
  "agent.tool_result",
  "agent.custom_tool_use",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
  "session.status_running",
  "session.status_idle",
  "session.status_rescheduled",
  "session.status_terminated",
  "session.error",
  "session.usage",
  "session.updated",
  "session.deleted",
  "span.model_request_start",
  "span.model_request_end",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const isEventType = (t: string): t is EventType =>
  (EVENT_TYPES as readonly string[]).includes(t);

const textBlock = z
  .object({ type: z.literal("text"), text: z.string().min(1).max(64_000) })
  .strict();

const imageBlock = z
  .object({
    type: z.literal("image"),
    source: z
      .object({
        type: z.literal("base64"),
        media_type: z.string().min(3).max(128),
        data: z.string().min(1).max(8_000_000),
      })
      .strict(),
  })
  .strict();

const documentBlock = z
  .object({
    type: z.literal("document"),
    source: z.union([
      z.object({ type: z.literal("text"), media_type: z.string(), text: z.string().max(200_000) }).strict(),
      z.object({ type: z.literal("file"), file_id: z.string().min(3) }).strict(),
    ]),
  })
  .strict();

export const contentBlockSchema = z.union([textBlock, imageBlock, documentBlock]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const userMessageEventSchema = z
  .object({ type: z.literal("user.message"), content: z.array(contentBlockSchema).min(1).max(20) })
  .strict()
  .superRefine((e, ctx) => {
    const images = e.content.filter((b) => b.type === "image");
    if (images.length > 4) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at most 4 images per message" });
    }
    for (const img of images) {
      const bytes = Buffer.from(img.source.data, "base64");
      if (bytes.length > 5 * 1024 * 1024) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "decoded image exceeds 5 MB" });
      }
    }
  });

export const userInterruptEventSchema = z.object({ type: z.literal("user.interrupt") }).strict();

export const userToolConfirmationEventSchema = z
  .object({
    type: z.literal("user.tool_confirmation"),
    tool_use_id: z.string().min(3),
    result: z.enum(["allow", "deny"]),
    deny_message: z.string().max(4_000).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.result === "allow" && e.deny_message !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deny_message is only allowed with result=deny",
      });
    }
  });

/**
 * 自定义工具结果（custom tools，spec §7.3 例外）：收到即处理——
 * api 当场定序（返回时 processed_at 已有值），再生成 execution 送回 runtime。
 */
export const userCustomToolResultEventSchema = z
  .object({
    type: z.literal("user.custom_tool_result"),
    tool_use_id: z.string().min(3),
    output: z.string().min(1).max(64_000),
  })
  .strict();

export const userInputEventSchema = z.union([
  userMessageEventSchema,
  userInterruptEventSchema,
  userToolConfirmationEventSchema,
  userCustomToolResultEventSchema,
]);
export type UserInputEvent = z.infer<typeof userInputEventSchema>;

/**
 * 发送事件批次校验（EVT-S02/03/07/08）：
 * - 1..10 条，整批原子；
 * - 只接受用户事件；
 * - requires_action 时只接受 tool_confirmation/interrupt（TOOL-07/08）。
 */
export function validateEventBatch(
  events: unknown[],
  sessionStatus: string,
): UserInputEvent[] {
  if (!Array.isArray(events) || events.length < 1 || events.length > 10) {
    throw errInvalid("events must be an array of 1 to 10 events");
  }
  const parsed = events.map((e) => {
    const r = userInputEventSchema.safeParse(e);
    if (!r.success) {
      throw errInvalid(`invalid event: ${r.error.issues[0]?.message ?? "schema mismatch"}`);
    }
    return r.data;
  });
  const requiresAction = sessionStatus === "idle" ? false : undefined;
  void requiresAction;
  return parsed;
}

/** 持久化后对外的事件信封（spec §5.4）。 */
export interface SessionEventJson {
  id: string;
  type: EventType;
  processed_at: string | null;
  [k: string]: unknown;
}

export function eventToJson(row: {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  processed_at: Date | null;
}): SessionEventJson {
  return {
    id: row.id,
    type: row.type as EventType,
    processed_at: row.processed_at ? row.processed_at.toISOString().replace(/\.\d{3}Z$/, "Z") : null,
    ...row.payload,
  };
}
