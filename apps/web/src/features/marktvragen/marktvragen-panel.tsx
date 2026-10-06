"use client";

import { Button } from "@ji/ui/components/button";
import { fixturesEnabled } from "@ji/env/web";
import { isToolUIPart } from "ai";
import { Bot, MessageSquare, SendHorizonal, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { CapabilityDiscovery } from "@/features/job-intelligence/capability-discovery";
import { loadFixtureCapabilityDiscovery } from "@/features/job-intelligence/capability-discovery-fixture";
import { createRestJobIntelligence } from "@/features/job-intelligence/rest-job-data-adapter";

import { useMarktvragenChat } from "./marktvragen-chat-context";
import { MarktvragenToolPart } from "./tool-widgets";

const SUGGESTED_CHIPS = [
  "Zoek open aanvragen in Amsterdam",
  "Toon brongezondheid",
  "Hoeveel open aanvragen per bron?",
  "Lijst mijn opgeslagen zoekopdrachten",
] as const;

const loadLiveCapabilityDiscovery = () =>
  createRestJobIntelligence().loadCapabilityDiscovery();

export const MarktvragenMessages = () => {
  const { error, messages, status } = useMarktvragenChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      behavior: "smooth",
      top: scrollRef.current.scrollHeight,
    });
  }, [messages, status]);

  return (
    <div
      aria-live="polite"
      className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-4"
      ref={scrollRef}
    >
      {messages.length === 0 ? (
        <div className="space-y-2 px-1 pt-6 text-center">
          <p className="text-sm font-medium">Vraag de assistent</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Zoek aanvragen, bekijk bronnen, maak snapshots, of stel een
            marktvraag. De assistent gebruikt dezelfde capabilities als REST en
            MCP — alles wat jij als operator kunt.
          </p>
        </div>
      ) : null}
      {messages.map((message) => (
        <div
          className={
            message.role === "user" ? "flex justify-end" : "flex justify-start"
          }
          key={message.id}
        >
          <div
            className={
              message.role === "user"
                ? "max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                : "w-full max-w-full space-y-1 text-sm"
            }
          >
            {message.parts.map((part, index) => {
              if (part.type === "text") {
                return (
                  <p
                    className="leading-relaxed whitespace-pre-wrap"
                    key={`${message.id}:text:${index}`}
                  >
                    {part.text}
                  </p>
                );
              }
              if (isToolUIPart(part)) {
                return (
                  <MarktvragenToolPart key={part.toolCallId} part={part} />
                );
              }
              return null;
            })}
          </div>
        </div>
      ))}
      {status === "submitted" || status === "streaming" ? (
        <p className="text-xs text-muted-foreground">Assistent denkt na…</p>
      ) : null}
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          {error.message}
        </p>
      ) : null}
    </div>
  );
};

export const MarktvragenComposer = () => {
  const { enabled, messages, sendMessage, status, stop } = useMarktvragenChat();
  const [draft, setDraft] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const showChips = messages.length === 0 && !busy;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    void sendMessage(text);
  };

  return (
    <div className="border-t border-border">
      {showChips ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {SUGGESTED_CHIPS.map((chip) => (
            <button
              className="rounded-full border border-border bg-background px-2.5 py-1 text-left text-[11px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              disabled={!enabled}
              key={chip}
              onClick={() => void sendMessage(chip)}
              type="button"
            >
              {chip}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="flex items-end gap-2 px-3 py-3"
        onSubmit={onSubmit}
      >
        <label className="sr-only" htmlFor="assistent-input">
          Vraag aan de assistent
        </label>
        <textarea
          aria-label="Vraag aan de assistent"
          className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={!enabled}
          id="assistent-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit(event);
            }
          }}
          placeholder="Ask…"
          rows={1}
          value={draft}
        />
        {busy ? (
          <Button
            aria-label="Stop genereren"
            onClick={stop}
            size="icon"
            type="button"
            variant="outline"
          >
            <Square aria-hidden="true" />
          </Button>
        ) : (
          <Button
            aria-label="Verstuur vraag"
            disabled={!enabled || !draft.trim()}
            size="icon"
            type="submit"
          >
            <SendHorizonal aria-hidden="true" />
          </Button>
        )}
      </form>
    </div>
  );
};

/** Collapsible right-rail chat — primary operator surface (Agent-Native Mail style). */
export const MarktvragenPanel = () => {
  const { isOpen, setOpen } = useMarktvragenChat();

  if (!isOpen) {
    return null;
  }

  const loadCapabilities = fixturesEnabled
    ? loadFixtureCapabilityDiscovery
    : loadLiveCapabilityDiscovery;

  return (
    <aside
      aria-label="Assistent chat"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-xl sm:w-96"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Bot aria-hidden="true" className="size-4 text-primary" />
        <h2 className="flex-1 text-sm font-semibold">Assistent</h2>
        <CapabilityDiscovery compact load={loadCapabilities} />
        <button
          aria-label="Assistent-paneel sluiten"
          className="grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen(false)}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <MarktvragenMessages />
      <MarktvragenComposer />
    </aside>
  );
};

/** Floating open button — visible on every screen, bottom right. */
export const MarktvragenFab = () => {
  const { enabled, isOpen, setOpen } = useMarktvragenChat();

  if (!enabled || isOpen) {
    return null;
  }

  return (
    <button
      aria-label="Assistent-chat openen"
      className="fixed right-4 bottom-4 z-40 grid size-11 place-items-center rounded-full border border-border bg-primary text-primary-foreground shadow-lg outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => setOpen(true)}
      type="button"
    >
      <MessageSquare aria-hidden="true" className="size-5" />
    </button>
  );
};
