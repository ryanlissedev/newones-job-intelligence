import type { Metadata } from "next";
import { Suspense } from "react";

import { ExportsPageShell } from "@/features/job-intelligence/exports-list";

export const metadata: Metadata = {
  description:
    "Overzicht van zoeksnapshots met hun goedkeuring- en exportstatus.",
  title: "Exports · Newones",
};

const ExportsPage = () => (
  <Suspense
    fallback={
      <main
        className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-6 sm:px-6 lg:px-8"
        id="main-content"
      >
        <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
      </main>
    }
  >
    <ExportsPageShell />
  </Suspense>
);

export default ExportsPage;
