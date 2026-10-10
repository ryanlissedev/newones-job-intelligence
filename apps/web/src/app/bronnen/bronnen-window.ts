import { z } from "zod";

export const BRONNEN_WINDOWS = ["24h", "7d", "30d"] as const;

export type BronnenWindow = (typeof BRONNEN_WINDOWS)[number];

export const DEFAULT_BRONNEN_WINDOW: BronnenWindow = "7d";

const authUserRoleSchema = z.enum([
  "recruiter",
  "operator",
  "admin",
  "approver",
]);

export type AuthUserRole = z.infer<typeof authUserRoleSchema>;

export const sessionRoleSchema = z.object({
  user: z.object({
    role: authUserRoleSchema,
  }),
});

export const parseBronnenWindow = (
  value: string | string[] | undefined
): BronnenWindow => {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === "24h" || candidate === "7d" || candidate === "30d") {
    return candidate;
  }
  return DEFAULT_BRONNEN_WINDOW;
};

/** Map product URL window to capability API window (`24h` → `24u`). */
export const toDashboardApiWindow = (
  window: BronnenWindow
): "24u" | "7d" | "30d" => (window === "24h" ? "24u" : window);

export const canAccessBronnen = (
  role: AuthUserRole | null | undefined
): boolean => role === "operator" || role === "admin";
