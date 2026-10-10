import { SUPPORTED_BRON_SLUGS } from "@ji/application/sources";
import { z } from "zod";

export const pollBronPayload = z.object({
  bronId: z.string().uuid(),
  bronSlug: z.enum(SUPPORTED_BRON_SLUGS),
  scrapeRunId: z.string().uuid(),
});

export type PollBronPayload = z.infer<typeof pollBronPayload>;
