import { fixturesEnabled } from "@ji/env/web";
import { Button } from "@ji/ui/components/button";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { UUID_RE } from "@/app/bronnen/runs/runs-query";
import { SnapshotDetail } from "@/features/job-intelligence/snapshot-detail";
import { getServerAuthClient } from "@/lib/auth-server";

export const metadata: Metadata = {
  description:
    "Immutable QuerySnapshot met goedkeuring en exportstatus naar Spott.",
  title: "Snapshot · Catapulze Job Intelligence",
};

/**
 * Auth matches the capability boundary loosely: any signed-in session may
 * open the screen; get_snapshot itself enforces the recruiter permission
 * server-side (403 → "Geen toegang"), approval/export carry their own
 * PERM_APPROVAL / PERM_EXPORT checks that surface in the cards.
 */
const requireSession = async (): Promise<void> => {
  const session = await getServerAuthClient().getSession({
    fetchOptions: {
      headers: await headers(),
      throw: true,
    },
  });
  if (!session?.user.id) {
    redirect("/login");
  }
};

export default async function SnapshotPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    notFound();
  }
  if (!fixturesEnabled) {
    await requireSession();
  }

  return (
    <main
      className="mx-auto w-full max-w-[1100px] space-y-6 px-4 py-6 sm:px-6 lg:px-8"
      id="main-content"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
            QuerySnapshot
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
            Snapshot
          </h1>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{id}</p>
        </div>
        <Button
          nativeButton={false}
          render={<Link href="/jobs" />}
          variant="outline"
        >
          Terug naar opdrachten
        </Button>
      </div>
      <SnapshotDetail snapshotId={id} />
    </main>
  );
}
