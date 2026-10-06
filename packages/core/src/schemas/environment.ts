import { z } from "zod";
import { metadataSchema } from "./common.js";

const HOST_RE = /^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

const allowedHost = z
  .string()
  .min(1)
  .max(253)
  .refine((h) => HOST_RE.test(h), {
    message: "allowed_hosts entries must be bare hostnames (no scheme, port or path); wildcard '*.example.com' allowed",
  });

const packageList = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine((s) => !/\s/.test(s), "package names must not contain whitespace")
      .refine((s) => !s.startsWith("-"), "package names must not start with '-'"),
  )
  .max(200);

const networkingSchema = z.union([
  z.object({ type: z.literal("unrestricted") }).strict(),
  z
    .object({
      type: z.literal("limited"),
      allowed_hosts: z.array(allowedHost).max(256),
      allow_package_managers: z.boolean().optional(),
      allow_mcp_servers: z.boolean().optional(),
    })
    .strict(),
]);

const packagesSchema = z
  .object({
    apt: packageList.optional(),
    npm: packageList.optional(),
    pip: packageList.optional(),
    cargo: packageList.optional(),
    gem: packageList.optional(),
    go: packageList.optional(),
  })
  .strict();

const envConfigSchema = z
  .object({ type: z.literal("cloud"), packages: packagesSchema.optional(), networking: networkingSchema.optional() })
  .strict();

export const environmentCreateSchema = z
  .object({
    name: z.string().min(1).max(256),
    description: z.string().max(2048).nullable().optional(),
    config: envConfigSchema,
    metadata: metadataSchema.optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const config = e.config;
    if (config.networking?.type === "unrestricted" && "allowed_hosts" in config.networking) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "allowed_hosts is not allowed with unrestricted networking" });
    }
    const hasPackages = config.packages && Object.values(config.packages).some((l) => (l ?? []).length > 0);
    if (hasPackages && config.networking?.type === "limited" && !config.networking.allow_package_managers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "packages require networking.allow_package_managers=true",
      });
    }
  });

export const environmentUpdateSchema = z
  .object({
    name: z.string().min(1).max(256).nullable().optional(),
    description: z.string().max(2048).nullable().optional(),
    config: envConfigSchema.nullable().optional(),
    metadata: metadataSchema.nullable().optional(),
  })
  .strict();

export type EnvironmentConfig = z.infer<typeof envConfigSchema>;

/** 规范化：packages 6 字段全出现；networking 默认 unrestricted；limited 布尔默认 false（ENV-01/02）。 */
export function normalizeEnvironmentConfig(config: EnvironmentConfig): {
  type: "cloud";
  packages: { apt: string[]; npm: string[]; pip: string[]; cargo: string[]; gem: string[]; go: string[] };
  networking:
    | { type: "unrestricted" }
    | { type: "limited"; allowed_hosts: string[]; allow_package_managers: boolean; allow_mcp_servers: boolean };
} {
  const p = config.packages ?? {};
  if (config.networking?.type === "limited") {
    return {
      type: "cloud",
      packages: {
        apt: p.apt ?? [],
        npm: p.npm ?? [],
        pip: p.pip ?? [],
        cargo: p.cargo ?? [],
        gem: p.gem ?? [],
        go: p.go ?? [],
      },
      networking: {
        type: "limited",
        allowed_hosts: config.networking.allowed_hosts,
        allow_package_managers: config.networking.allow_package_managers ?? false,
        allow_mcp_servers: config.networking.allow_mcp_servers ?? false,
      },
    };
  }
  return {
    type: "cloud",
    packages: {
      apt: p.apt ?? [],
      npm: p.npm ?? [],
      pip: p.pip ?? [],
      cargo: p.cargo ?? [],
      gem: p.gem ?? [],
      go: p.go ?? [],
    },
    networking: { type: "unrestricted" },
  };
}
