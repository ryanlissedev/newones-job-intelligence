"use client";

import { fixturesEnabled } from "@ji/env/web";
import { useEffect, useMemo, useState } from "react";

import { authClient } from "@/lib/auth-client";

import { fixtureJobActions, fixtureJobDataAdapter } from "./fixtures";
import { JobSearchPage } from "./job-search-page";
import { JobsAccessFrame } from "./jobs-access";
import { resolveJobsAccess } from "./jobs-access-state";
import { createRestJobIntelligence } from "./rest-job-data-adapter";

export const JobSearchShell = () => {
  const { data: session, isPending } = authClient.useSession();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const access = resolveJobsAccess({
    fixtures: fixturesEnabled,
    isPending,
    mounted,
    userId: session?.user.id,
  });
  // The REST wiring (and with it every data request) only exists once the
  // session is confirmed.
  const wiring = useMemo(
    () => (access === "authenticated" ? createRestJobIntelligence() : null),
    [access]
  );

  if (access === "fixtures") {
    return (
      <JobSearchPage
        actions={fixtureJobActions}
        adapter={fixtureJobDataAdapter}
      />
    );
  }

  if (access === "anonymous") {
    return <JobsAccessFrame access="anonymous" />;
  }

  if (access === "checking" || !wiring) {
    return <JobsAccessFrame access="checking" />;
  }

  return (
    <JobSearchPage actions={wiring.actions} adapter={wiring.adapter} liveData />
  );
};
