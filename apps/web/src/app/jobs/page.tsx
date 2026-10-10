import type { Metadata } from "next";
import { Suspense } from "react";

import { JobSearchShell } from "@/features/job-intelligence/job-search-shell";
import { JobsAccessFrame } from "@/features/job-intelligence/jobs-access";

export const metadata: Metadata = {
  description:
    "Doorzoek opdrachten met Boolean-logica, filters en volledige herkomstinformatie.",
  title: "Opdrachten zoeken · Newones",
};

const JobsPage = () => (
  <Suspense fallback={<JobsAccessFrame access="checking" />}>
    <JobSearchShell />
  </Suspense>
);

export default JobsPage;
