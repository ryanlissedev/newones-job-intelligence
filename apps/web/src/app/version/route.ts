import { env } from "@ji/env/web";

import { releaseResponse } from "@/lib/release";

export const dynamic = "force-dynamic";

export const GET = (): Response => releaseResponse(env.APP_RELEASE_SHA);
