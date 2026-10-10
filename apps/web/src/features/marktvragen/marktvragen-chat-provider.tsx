"use client";

import { useChat } from "@ai-sdk/react";
import { env } from "@ji/env/web";
import { DefaultChatTransport } from "ai";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { authClient } from "@/lib/auth-client";

import { MarktvragenChatContext } from "./marktvragen-chat-context";
import type {
  MarktvragenChatContextValue,
  MarktvragenScreen,
} from "./marktvragen-chat-context";

export { useMarktvragenChat } from "./marktvragen-chat-context";

const screenForPath = (pathname: string): MarktvragenScreen => {
  if (pathname.startsWith("/jobs")) {
    return { kind: "search", label: "Zoekresultaten" };
  }
  if (pathname.startsWith("/bronnen")) {
    return { kind: "dashboard", label: "Bronnenoverzicht" };
  }
  if (pathname.startsWith("/chat")) {
    return { kind: "chat" };
  }
  return { kind: "dashboard", label: "Overzicht" };
};

/**
 * Holds the single Marktvragen conversation for the whole app shell — the
 * sidebar and /chat render the same `useChat` state, so client-side
 * navigation keeps the thread. A full page reload starts a fresh chatId
 * (history restore is a documented follow-up).
 *
 * Transport is the on-box route on apps/server: the browser posts the UI
 * messages plus the current screen context, the better-auth session cookie
 * authorizes the turn (credentials: "include"), and the response is the same
 * UI message stream the Trigger.dev transport produced.
 */
export const MarktvragenChatProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const [isOpen, setOpen] = useState(false);
  const [screenOverride, setScreenOverride] =
    useState<MarktvragenScreen | null>(null);

  // Mint the client-only suffix after hydration. Generating it during the
  // initial render makes the app shell differ between server and browser.
  const [chatIdSuffix, setChatIdSuffix] = useState<string | null>(null);
  useEffect(() => {
    setChatIdSuffix(crypto.randomUUID());
  }, []);
  const chatId =
    session?.user?.id && chatIdSuffix
      ? `${session.user.id}~${chatIdSuffix}`
      : null;

  const screen = screenOverride ?? screenForPath(pathname);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${env.NEXT_PUBLIC_SERVER_URL}/marktvragen/chat`,
        body: () => ({ screen }),
        credentials: "include",
      }),
    [screen]
  );

  const { error, messages, sendMessage, status, stop } = useChat({
    id: chatId ?? "marktvragen-anonymous",
    transport,
  });

  const enabled = chatId !== null;

  const send = useCallback(
    async (text: string) => {
      if (!(enabled && text.trim())) {
        return;
      }
      await sendMessage({ text: text.trim() });
    },
    [enabled, sendMessage]
  );

  const sendToChat = useCallback(
    (text: string, targetScreen?: MarktvragenScreen) => {
      if (targetScreen) {
        setScreenOverride(targetScreen);
      }
      setOpen(true);
      void send(text);
    },
    [send]
  );

  const value = useMemo<MarktvragenChatContextValue>(
    () => ({
      chatId,
      enabled,
      error,
      isOpen,
      messages,
      sendMessage: send,
      sendToChat,
      setOpen,
      status,
      stop,
    }),
    [chatId, enabled, error, isOpen, messages, send, sendToChat, status, stop]
  );

  return (
    <MarktvragenChatContext.Provider value={value}>
      {children}
    </MarktvragenChatContext.Provider>
  );
};
