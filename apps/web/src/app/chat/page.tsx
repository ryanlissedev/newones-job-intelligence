import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  MarktvragenComposer,
  MarktvragenMessages,
} from "@/features/marktvragen/marktvragen-panel";
import { getServerAuthClient } from "@/lib/auth-server";

export default async function ChatPage() {
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
    <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 py-6 sm:px-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        Assistent
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Chat met de operatorassistent: zoeken, bronnen, snapshots, exports en
        marktdata — dezelfde capabilities als REST en MCP.
      </p>
      <div className="mt-4 flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-card">
        <MarktvragenMessages />
        <MarktvragenComposer />
      </div>
    </main>
  );
}
