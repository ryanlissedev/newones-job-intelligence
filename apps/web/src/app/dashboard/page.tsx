import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getServerAuthClient } from "@/lib/auth-server";

import Dashboard from "./dashboard";

export default async function DashboardPage() {
  // Server-side session lookup: this fetch leaves the web container, so it
  // must use the internal API URL (see apps/web/src/lib/auth-server.ts), not
  // the browser-facing NEXT_PUBLIC_SERVER_URL.
  const session = await getServerAuthClient().getSession({
    fetchOptions: {
      headers: await headers(),
      throw: true,
    },
  });

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <>
      <section className="mx-auto w-full max-w-[1600px] space-y-2 px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-muted-foreground">
          Welcome {session.user.name}
        </p>
      </section>
      <Dashboard />
    </>
  );
}
