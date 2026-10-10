import { env } from "@ji/env/server";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Marktvragen chat model (on-box route, JI-DSH-07). Model identity is
 * deployment config, not code — prod runs an OpenRouter free-tier model; the
 * key lives in the server app env, never in git. Lazy: the module must import
 * without OPENROUTER_API_KEY so the server still boots when chat is not
 * configured; the first real turn then fails closed with a clear error.
 */
const DEFAULT_CHAT_MODEL = "openai/gpt-oss-120b";

let model: LanguageModel | undefined;

export const getMarktvragenModel = (): LanguageModel => {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is required for the marktvragen chat");
  }
  model ??= createOpenRouter({ apiKey }).chat(
    env.MARKTVRAGEN_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL
  );
  return model;
};
