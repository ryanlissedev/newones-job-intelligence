import { Button } from "@ji/ui/components/button";
import Link from "next/link";
import type { ReactNode } from "react";

import { JobLoadingState } from "./job-search-states";

/**
 * The session-independent /jobs frame. It renders on the server, so its
 * heading paints with the first frame instead of after the session round trip
 * (650–800 ms on mobile), which is what held LCP back.
 */
const JobsAccessShell = ({ children }: { readonly children: ReactNode }) => (
  <main
    id="main-content"
    className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 lg:px-8"
  >
    {/* Same heading and copy as JobSearchToolbar, so signing in swaps the
        content below without moving the frame. */}
    <header className="min-w-0">
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        Opdrachten
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Boolean search met deelbare URL-state en zichtbare herkomst.
      </p>
    </header>
    {children}
  </main>
);

const SignInPrompt = () => (
  <section className="max-w-md space-y-3 rounded-lg border border-border bg-card p-6 shadow-sm">
    <h2 className="text-lg font-semibold">Log in om opdrachten te bekijken</h2>
    <p className="text-sm text-muted-foreground">
      Alleen beschikbaar met een geldig Newones-account.
    </p>
    <Button render={<Link href="/login" />} nativeButton={false}>
      Inloggen
    </Button>
  </section>
);

/**
 * /jobs before search is allowed. "checking": a skeleton, never results or a
 * sign-in verdict. "anonymous": the sign-in prompt. One component for both,
 * so when the session resolves React keeps the frame's DOM (the painted LCP
 * heading) and only swaps the content below it.
 */
export const JobsAccessFrame = ({
  access,
}: {
  readonly access: "anonymous" | "checking";
}) => (
  <JobsAccessShell>
    {access === "anonymous" ? (
      <SignInPrompt />
    ) : (
      <div className="rounded-lg border border-border bg-card">
        <JobLoadingState />
      </div>
    )}
  </JobsAccessShell>
);
