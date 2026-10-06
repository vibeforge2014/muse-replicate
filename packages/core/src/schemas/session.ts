import { z } from "zod";
import { metadataSchema } from "./common.js";
import { userInputEventSchema } from "./event.js";

const sessionResourceSchema = z
  .object({
    type: z.literal("file"),
    file_id: z.string().min(3).max(128),
    mount_path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) => !p.split("/").includes("..") && !p.startsWith("/") && p !== ".", {
        message: "mount_path must be a relative path without '..' segments",
      }),
  })
  .strict();
export type SessionResourceInput = z.infer<typeof sessionResourceSchema>;

/** agent 引用三形态（spec §11.4）。 */
const agentRefSchema = z.union([
  z.string().min(3),
  z
    .object({
      type: z.literal("agent"),
      id: z.string().min(3),
      version: z.number().int().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_with_overrides"),
      agent: z.union([
        z.string().min(3),
        z.object({ id: z.string().min(3), version: z.number().int().min(1).optional() }).strict(),
      ]),
      system: z.string().max(100_000).nullable().optional(),
      tools: z.array(z.unknown()).optional(),
      mcp_servers: z.array(z.unknown()).optional(),
      model: z.unknown().optional(),
    })
    .strict(),
]);

export const sessionCreateSchema = z
  .object({
    agent: agentRefSchema,
    environment_id: z.string().min(3),
    title: z.string().max(256).nullable().optional(),
    metadata: metadataSchema.optional(),
    resources: z.array(sessionResourceSchema).max(500).optional(),
    vault_ids: z.array(z.string().min(3)).max(20).optional(),
    initial_events: z.array(userInputEventSchema).max(50).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.initial_events) {
      for (const e of s.initial_events) {
        if (e.type !== "user.message") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "initial_events only accepts user.message" });
        }
      }
    }
    if (s.vault_ids) {
      const set = new Set(s.vault_ids);
      if (set.size !== s.vault_ids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "vault_ids must not contain duplicates" });
      }
    }
  });

export const sessionUpdateSchema = z
  .object({
    title: z.string().max(256).nullable().optional(),
    metadata: metadataSchema.nullable().optional(),
    agent: z
      .object({
        tools: z.array(z.unknown()).nullable().optional(),
        mcp_servers: z.array(z.unknown()).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const sessionListQuerySchema = z
  .object({
    agent_id: z.string().optional(),
    agent_version: z.coerce.number().int().min(1).optional(),
    statuses: z.string().optional(),
    include_archived: z.coerce.boolean().optional(),
  })
  .strict();
