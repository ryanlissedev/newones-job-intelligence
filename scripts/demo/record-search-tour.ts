/**
 * Authenticated overview of JI search methods + filters on the live sslip app.
 * Requires JI_DEMO_EMAIL / JI_DEMO_PASSWORD. Records x11grab+overlay+Dutch VO.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { SEARCH_TOUR_CUES } from "./narration-search";
import { resolveDemoTargets, runDemoPreflight } from "./preflight";
import type { DemoPreflightResult } from "./preflight";

const VIEWPORT = { height: 800, width: 1280 } as const;
const DEFAULT_VOICEOVER = "demos/.tmp/ji-demo-search-voiceover-nl.wav";

interface DemoCredentials {
  readonly email: string;
  readonly password: string;
}

const requireCredentials = (
  environment: Readonly<Record<string, string | undefined>>
): DemoCredentials => {
  const email = environment.JI_DEMO_EMAIL?.trim();
  const password = environment.JI_DEMO_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error(
      "JI_DEMO_EMAIL and JI_DEMO_PASSWORD are required (inject via secrets / 1Password)."
    );
  }
  return { email, password };
};

const stamp = (): string => {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
};

const dwell = async (ms: number): Promise<void> => {
  await delay(ms);
};

const cueGapMs = (fromLabel: string, toLabel: string): number => {
  const from = SEARCH_TOUR_CUES.find((cue) => cue.label === fromLabel);
  const to = SEARCH_TOUR_CUES.find((cue) => cue.label === toLabel);
  if (!(from && to)) {
    return 2500;
  }
  return Math.max(1200, Math.round((to.at - from.at) * 1000));
};

const installVisibleCursor = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = `
      #ji-demo-cursor {
        position: fixed; top: 0; left: 0; width: 28px; height: 28px;
        margin: -6px 0 0 -6px; border: 3px solid #f97316; border-radius: 9999px;
        background: rgba(249, 115, 22, 0.25);
        box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.85);
        pointer-events: none; z-index: 2147483647;
        transform: translate3d(-100px, -100px, 0);
      }
    `;
    const boot = (): void => {
      if (document.querySelector("#ji-demo-cursor")) {
        return;
      }
      document.documentElement.append(style);
      const cursor = document.createElement("div");
      cursor.id = "ji-demo-cursor";
      document.documentElement.append(cursor);
      window.addEventListener(
        "mousemove",
        (event) => {
          cursor.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
        },
        { passive: true }
      );
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
  });
};

const moveCursor = async (page: Page, x: number, y: number): Promise<void> => {
  await page.mouse.move(x, y, { steps: 22 });
};

const clickLocator = async (page: Page, locator: Locator): Promise<void> => {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Locator has no bounding box.");
  }
  await moveCursor(page, box.x + box.width / 2, box.y + box.height / 2);
  await dwell(200);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

const waitForResults = async (page: Page): Promise<void> => {
  const results = page.getByLabel("Zoekresultaten");
  const gate = page.getByRole("heading", {
    name: "Log in om opdrachten te bekijken",
  });
  const unavailable = page.getByText("tijdelijk niet beschikbaar");
  await Promise.race([
    results.waitFor({ state: "visible", timeout: 45_000 }),
    gate.waitFor({ state: "visible", timeout: 45_000 }),
    unavailable.waitFor({ state: "visible", timeout: 45_000 }),
  ]);
  if (await gate.isVisible().catch(() => false)) {
    throw new Error("Search auth gate still visible after sign-in.");
  }
  if (await unavailable.isVisible().catch(() => false)) {
    throw new Error("Search temporarily unavailable.");
  }
};

const signIn = async (
  page: Page,
  credentials: DemoCredentials
): Promise<void> => {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Welcome Back" }).waitFor({
    state: "visible",
  });
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await clickLocator(page, page.getByRole("button", { name: "Sign In" }));
  await page.waitForURL(/\/(?:dashboard)?\/?(?:\?.*)?$/u, { timeout: 30_000 });
};

const submitQuery = async (page: Page, query: string): Promise<void> => {
  const input = page.locator("#job-query");
  await clickLocator(page, input);
  await input.fill(query);
  await clickLocator(page, page.getByRole("button", { name: "Zoeken" }));
  await waitForResults(page);
};

const ensureFacetOpen = async (page: Page, title: string): Promise<void> => {
  const heading = page.getByRole("button", { exact: true, name: title });
  await heading.waitFor({ state: "visible", timeout: 15_000 });
  const expanded = await heading.getAttribute("aria-expanded");
  if (expanded === "false") {
    await clickLocator(page, heading);
  }
};

const checkFirstFacetOption = async (
  page: Page,
  groupTitle: string
): Promise<boolean> => {
  await ensureFacetOpen(page, groupTitle);
  const group = page.locator("fieldset").filter({
    has: page.getByRole("button", { exact: true, name: groupTitle }),
  });
  const option = group.locator('label:has(input[type="checkbox"])').first();
  if ((await option.count()) === 0) {
    return false;
  }
  await clickLocator(page, option);
  await waitForResults(page);
  return true;
};

const runSearchTour = async (
  page: Page,
  credentials: DemoCredentials
): Promise<void> => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByText("Job Intelligence")
    .first()
    .waitFor({ state: "visible" });
  await moveCursor(page, 220, 160);
  await dwell(cueGapMs("intro", "boolean-or"));

  await signIn(page, credentials);

  await page.goto("/jobs", { waitUntil: "domcontentloaded" });
  await waitForResults(page);

  // Boolean OR + phrase + NOT
  await submitQuery(page, '(Azure OR "Power BI") NOT junior');
  await moveCursor(page, 520, 240);
  await dwell(cueGapMs("boolean-or", "boolean-and"));

  // Boolean AND
  await submitQuery(page, "Azure AND data");
  await moveCursor(page, 480, 260);
  await dwell(cueGapMs("boolean-and", "filters"));

  // Facet filters
  await checkFirstFacetOption(page, "Bron");
  await checkFirstFacetOption(page, "Contract");
  await ensureFacetOpen(page, "Gepubliceerd");
  await page.getByLabel("Filter op publicatiedatum").selectOption("30d");
  await waitForResults(page);
  const rate = page.getByLabel("Minimum uurtarief").first();
  if ((await rate.count()) > 0 && (await rate.isVisible().catch(() => false))) {
    await clickLocator(page, rate);
    await rate.fill("80");
    await rate.blur();
    await waitForResults(page);
  }
  await moveCursor(page, 200, 420);
  await dwell(cueGapMs("filters", "sort"));

  // Sort
  await page.getByLabel("Resultaten sorteren").first().selectOption("newest");
  await waitForResults(page);
  await dwell(cueGapMs("sort", "archive"));

  // Archive
  const archive = page.getByLabel("Ook in archief zoeken").first();
  await clickLocator(page, archive);
  await page.waitForURL(/archief=1/u, { timeout: 15_000 });
  await waitForResults(page);
  await dwell(cueGapMs("archive", "clear-detail"));

  // Clear filters via clean /jobs, then open one result with provenance
  await page.goto("/jobs", { waitUntil: "domcontentloaded" });
  await waitForResults(page);
  await submitQuery(page, "java OR devops");
  const result = page
    .locator('[aria-label="Zoekresultaten"] table tbody button')
    .first();
  await result.waitFor({ state: "visible", timeout: 45_000 });
  await result.scrollIntoViewIfNeeded();
  const box = await result.boundingBox();
  if (box) {
    await moveCursor(page, box.x + box.width / 2, box.y + box.height / 2);
    await dwell(200);
  }
  // Prefer Playwright click: mouse coordinates can miss after long tours / scroll.
  await result.click();
  await Promise.race([
    page.waitForURL(/[?&]job=/u, { timeout: 20_000 }),
    page.locator("#desktop-job-detail-title").waitFor({
      state: "visible",
      timeout: 20_000,
    }),
  ]);
  await page.locator("#desktop-job-detail-title").waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await moveCursor(page, 980, 300);
  await dwell(3500);
};

const startX11Grab = (display: string, rawPath: string) => {
  const displayId = display.replace(/^:/u, "");
  const proc = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-y",
      "-video_size",
      `${VIEWPORT.width}x${VIEWPORT.height}`,
      "-framerate",
      "30",
      "-f",
      "x11grab",
      "-draw_mouse",
      "1",
      "-i",
      `:${displayId}.0+0,0`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      "-crf",
      "23",
      rawPath,
    ],
    stderr: "pipe",
    stdout: "ignore",
  });
  return {
    kill: () => {
      try {
        process.kill(proc.pid, "SIGINT");
      } catch {
        // already exited
      }
    },
  };
};

const muxVoiceover = (
  videoPath: string,
  voiceoverPath: string,
  outPath: string
): void => {
  const result = Bun.spawnSync({
    cmd: [
      "ffmpeg",
      "-y",
      "-i",
      videoPath,
      "-i",
      voiceoverPath,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      // Pad VO with silence so -shortest keeps the full x11grab (incl. detail).
      "-af",
      "apad",
      "-shortest",
      "-movflags",
      "+faststart",
      outPath,
    ],
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(`ffmpeg mux failed for ${outPath}`);
  }
};

const probeDurationSeconds = (mediaPath: string): number => {
  const result = Bun.spawnSync({
    cmd: [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mediaPath,
    ],
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("ffprobe failed.");
  }
  const seconds = Number(new TextDecoder().decode(result.stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("non-positive duration");
  }
  return seconds;
};

const writeMeta = async (
  metaPath: string,
  preflight: DemoPreflightResult,
  durationSeconds: number
): Promise<void> => {
  await writeFile(
    metaPath,
    `tip=${preflight.releaseSha} duration_s=${durationSeconds.toFixed(1)} cursor=x11grab+overlay tour=search-methods-filters app=${preflight.appUrl}\n`,
    "utf-8"
  );
};

const main = async (): Promise<void> => {
  const environment = process.env;
  const credentials = requireCredentials(environment);
  const targets = resolveDemoTargets(environment);
  const outDir = environment.JI_DEMO_OUT_DIR?.trim() || "demos";
  const display = environment.DISPLAY?.trim() || ":1";
  const voiceoverPath =
    environment.JI_DEMO_SEARCH_VOICEOVER?.trim() || DEFAULT_VOICEOVER;

  const preflight = await runDemoPreflight(targets);
  await mkdir(path.join(outDir, ".tmp"), { recursive: true });

  const day = stamp();
  const baseName = `ji-search-methods-demo-${day}`;
  const rawPath = path.join(outDir, ".tmp", `${baseName}-raw.mp4`);
  const mp4Path = path.join(outDir, `${baseName}.mp4`);
  const metaPath = path.join(outDir, `${baseName}.meta.txt`);

  const grab = startX11Grab(display, rawPath);
  await dwell(800);

  const browser = await chromium.launch({
    args: [
      `--window-position=0,0`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "--disable-features=TranslateUI",
      "--disable-translate",
    ],
    env: { ...process.env, DISPLAY: display },
    headless: false,
  });
  const context = await browser.newContext({
    baseURL: preflight.appUrl,
    locale: "nl-NL",
    viewport: VIEWPORT,
  });
  const page = await context.newPage();
  await installVisibleCursor(page);

  try {
    await runSearchTour(page, credentials);
  } finally {
    await context.close();
    await browser.close();
    grab.kill();
    await dwell(1200);
  }

  if (!(await Bun.file(rawPath).exists())) {
    throw new Error("x11grab raw missing");
  }
  if (!(await Bun.file(voiceoverPath).exists())) {
    throw new Error(`voiceover missing: ${voiceoverPath}`);
  }

  muxVoiceover(rawPath, voiceoverPath, mp4Path);
  const durationSeconds = probeDurationSeconds(mp4Path);
  await writeMeta(metaPath, preflight, durationSeconds);

  console.log(
    JSON.stringify(
      {
        durationSeconds,
        metaPath,
        mp4Path,
        ok: true,
        releaseSha: preflight.releaseSha,
        tour: "search-methods-filters",
      },
      null,
      2
    )
  );
};

if (import.meta.main) {
  await main();
}
