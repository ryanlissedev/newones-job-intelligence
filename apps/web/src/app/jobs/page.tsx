import type { Metadata } from "next";
import { Suspense } from "react";

import { JobSearchShell } from "@/features/job-intelligence/job-search-shell";
import { JobLoadingState } from "@/features/job-intelligence/job-search-states";

export const metadata: Metadata = {
  description:
    "Doorzoek opdrachten met Boolean-logica, filters en volledige herkomstinformatie.",
  title: "Opdrachten zoeken · Newones",
};

const JobsPage = () => (
  <Suspense
    fallback={
      <main
        id="main-content"
        className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 lg:px-8"
      >
        <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
        <div className="rounded-lg border border-border bg-card">
          <JobLoadingState />
        </div>
      </main>
    }
  >
    <JobSearchShell />
  </Suspense>
);

export default JobsPage;
