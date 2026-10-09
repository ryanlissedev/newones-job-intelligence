import { Button } from "@ji/ui/components/button";
import Link from "next/link";
import type { ReactNode } from "react";

import { JobLoadingState } from "./job-search-states";

/**
 * What /jobs may show for the current session. "checking" covers the server
 * render, the first client render and the in-flight session request: nothing
 * session-dependent is decided there, so the server HTML and hydration agree
 * and no protected data (or data request) exists before the session is known.
 */
export type JobsAccess =
  | "anonymous"
  | "authenticated"
  | "checking"
  | "fixtures";

export const resolveJobsAccess = ({
  fixtures,
  isPending,
  mounted,
  userId,
}: {
  readonly fixtures: boolean;
  readonly isPending: boolean;
  readonly mounted: boolean;
  readonly userId: string | undefined;
}): JobsAccess => {
  if (fixtures) {
    return "fixtures";
  }
  if (!mounted || isPending) {
    return "checking";
  }
  return userId ? "authenticated" : "anonymous";
};

/**
 * The session-independent /jobs frame. It renders on the server, so its
 * heading paints with the first frame instead of after the session round trip
 * (650–800 ms on mobile), which is what held LCP back.
 */
export const JobsAccessShell = ({
  children,
}: {
  readonly children: ReactNode;
}) => (
  <main
    id="main-content"
    className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 lg:px-8"
  >
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">
        Opdrachten zoeken
      </h1>
      <p className="text-muted-foreground">
        Doorzoek opdrachten met Boolean-logica, filters en volledige
        herkomstinformatie.
      </p>
    </header>
    {children}
  </main>
);

/** Session still unknown: a skeleton, never results or a sign-in verdict. */
export const JobsSessionPending = () => (
  <JobsAccessShell>
    <div className="rounded-lg border border-border bg-card">
      <JobLoadingState />
    </div>
  </JobsAccessShell>
);

/** Session known to be absent. */
export const JobsSignInPrompt = () => (
  <JobsAccessShell>
    <section className="max-w-md space-y-3 rounded-lg border border-border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold">
        Log in om opdrachten te bekijken
      </h2>
      <p className="text-sm text-muted-foreground">
        Alleen beschikbaar met een geldig Newones-account.
      </p>
      <Button render={<Link href="/login" />} nativeButton={false}>
        Inloggen
      </Button>
    </section>
  </JobsAccessShell>
);
