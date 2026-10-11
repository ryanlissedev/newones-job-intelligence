/* oxlint-disable eslint/no-promise-executor-return, promise/avoid-new, anti-slop/require-safety-comment-for-type-assertion -- animation-frame barriers inside browser.evaluate need raw promises; the E2E_VISUAL value is checked against VISUAL_MODES before narrowing. */
import type { Browser } from "@e2e-dev/web";
import type { App } from "e2e";

export type VisualMode = "off" | "report" | "enforce" | "update";

const VISUAL_MODES = new Set<VisualMode>([
  "off",
  "report",
  "enforce",
  "update",
]);
const FROZEN_INSTANT = "2026-09-01T09:00:00+02:00";
const DEFAULT_MASKS = ["time", "[data-visual-mask]"];

export const FIXTURE_VISUAL_INSTANT = FROZEN_INSTANT;

export const visualMode = (): VisualMode => {
  const value = process.env.E2E_VISUAL;
  return value && VISUAL_MODES.has(value as VisualMode)
    ? (value as VisualMode)
    : "off";
};

/**
 * The clock shim is a plain source string, not `fn.toString()`: the e2e
 * runner transpiles test code with name helpers (`__name`) that do not exist
 * in the page, so a stringified function throws there and leaves the real
 * clock in place. Anchored at `isoInstant`, it advances with
 * `performance.now()` so timers and durations keep working.
 */
const frozenClockFunction = (isoInstant: string): string =>
  `() => {
  if (window.__e2eFrozenClock) { return null; }
  const RealDate = window.Date;
  const base = RealDate.parse(${JSON.stringify(isoInstant)});
  const started = performance.now();
  const now = () => Math.floor(base + performance.now() - started);
  function FrozenDate(...args) {
    if (!new.target) { return new RealDate(now()).toString(); }
    return args.length > 0 ? new RealDate(...args) : new RealDate(now());
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = now;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  Object.setPrototypeOf(FrozenDate, RealDate);
  window.Date = FrozenDate;
  window.__e2eFrozenClock = true;
  return null;
}`;

export const freezeClock = async (
  browser: Browser,
  baseUrl: string,
  isoInstant: string
): Promise<void> => {
  const { origin } = new URL(baseUrl);
  await browser.route("**", async (route) => {
    if (new URL(route.request.url).origin !== origin) {
      await route.continue();
      return;
    }
    const accept = route.request.headers.accept ?? "";
    const isDocument =
      route.request.method === "GET" &&
      (accept.includes("text/html") ||
        route.request.headers["sec-fetch-mode"] === "navigate");
    if (!isDocument) {
      await route.continue();
      return;
    }

    const response = await fetch(route.request.url, {
      headers: route.request.headers,
      method: route.request.method,
      // Hand redirects back to the browser so it navigates (and is
      // intercepted again) exactly as without the clock shim.
      redirect: "manual",
    });
    const isHtml = (response.headers.get("content-type") ?? "").includes(
      "text/html"
    );
    if (!isHtml) {
      const passthroughHeaders = Object.fromEntries(response.headers.entries());
      delete passthroughHeaders["content-encoding"];
      delete passthroughHeaders["content-length"];
      await route.fulfill({
        body: Buffer.from(await response.arrayBuffer()).toString("utf-8"),
        headers: passthroughHeaders,
        status: response.status,
      });
      return;
    }
    const html = await response.text();
    const clockScript = `<script>(${frozenClockFunction(isoInstant)})()</script>`;
    const body = html.replace(
      /<head[^>]*>/u,
      (head) => `${head}${clockScript}`
    );
    const headers = Object.fromEntries(response.headers.entries());
    delete headers["content-encoding"];
    delete headers["content-length"];
    await route.fulfill({ body, headers, status: response.status });
  });
};

export const applyFrozenClock = async (
  browser: Browser,
  isoInstant: string
): Promise<void> => {
  // evaluate() takes a function-expression source and calls it.
  await browser.evaluate(frozenClockFunction(isoInstant));
};

const validName = /^[a-z0-9-]+$/u;

export const captureVisual = async (
  { app, browser }: { app: App; browser: Browser },
  name: string,
  options: { mask?: readonly string[] } = {}
): Promise<string | null> => {
  if (visualMode() === "off") {
    return null;
  }
  if (!validName.test(name)) {
    throw new Error(`Visual name must match [a-z0-9-]+: ${name}`);
  }

  const masks = [...DEFAULT_MASKS, ...(options.mask ?? [])];
  await applyFrozenClock(browser, FROZEN_INSTANT);
  await browser.evaluate(async (selectors) => {
    const styleId = "e2e-visual-stability";
    document.querySelector(`#${styleId}`)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } html { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; } [data-sonner-toaster] { display: none !important; }`;
    document.head.append(style);
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
    window.scrollTo(0, 0);
    const overlay = document.createElement("div");
    overlay.id = "e2e-visual-masks";
    overlay.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden";
    // With a modal open, everything behind it is inert and dimmed: masking
    // those nodes would paint boxes over the dialog itself.
    const scope =
      document.querySelector('dialog[open], [role="dialog"]') ?? document;
    for (const selector of selectors) {
      for (const element of scope.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          continue;
        }
        const mask = document.createElement("div");
        mask.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#FF00FF;`;
        overlay.append(mask);
      }
    }
    document.body.append(overlay);
    return null;
  }, masks);
  const path = await app.screenshot(`visual-${name}`);
  await browser.evaluate(() => {
    document.querySelector("#e2e-visual-masks")?.remove();
    document.querySelector("#e2e-visual-stability")?.remove();
    return null;
  });
  return path;
};
