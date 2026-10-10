"use client";

import { Toaster } from "@ji/ui/components/sonner";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";

import { MarktvragenChatProvider } from "@/features/marktvragen/marktvragen-chat-provider";
import {
  MarktvragenFab,
  MarktvragenPanel,
} from "@/features/marktvragen/marktvragen-panel";
import { queryClient } from "@/utils/trpc";

import { ThemeProvider } from "./theme-provider";

export default function Providers({ children }: { children: React.ReactNode }) {
  // The approved console design is dark-first, so dark is the default a
  // first-time visitor lands on; Licht/Donker/Systeem stays selectable.
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <MarktvragenChatProvider>
          {children}
          <MarktvragenPanel />
          <MarktvragenFab />
        </MarktvragenChatProvider>
        {process.env.NODE_ENV === "development" ? <ReactQueryDevtools /> : null}
      </QueryClientProvider>
      <Toaster richColors />
    </ThemeProvider>
  );
}
