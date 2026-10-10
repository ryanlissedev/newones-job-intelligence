import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";

import { DEMO_NARRATION_CUES } from "./narration";
import { resolveDemoTargets, runDemoPreflight } from "./preflight";
import type { DemoPreflightResult } from "./preflight";

const VIEWPORT = { height: 800, width: 1280 } as const;
const DEFAULT_QUERY = "java OR devops";
const DEFAULT_VOICEOVER = "demos/.tmp/ji-demo-voiceover-nl.wav";

interface DemoCredentials {
  readonly email: string;
  readonly password: string;
}

interface GrabSession {
  readonly pid: number;
  readonly rawPath: string;
  readonly kill: () => void;
}

const requireCredentials = (
  environment: Readonly<Record<string, string | undefined>>
): DemoCredentials => {
  const email = environment.JI_DEMO_EMAIL?.trim();
  const password = environment.JI_DEMO_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error(
      "JI_DEMO_EMAIL and JI_DEMO_PASSWORD are required (inject via 1Password; never pass as argv)."
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

/**
 * Oversized ring cursor so the pointer stays readable on phone-sized reviews.
 * Native OS cursor is still captured via ffmpeg -draw_mouse 1.
 */
const installVisibleCursor = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = `
      #ji-demo-cursor {
        position: fixed;
        top: 0;
        left: 0;
        width: 28px;
        height: 28px;
        margin: -6px 0 0 -6px;
        border: 3px solid #f97316;
        border-radius: 9999px;
        background: rgba(249, 115, 22, 0.25);
        box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.85);
        pointer-events: none;
        z-index: 2147483647;
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
  await page.mouse.move(x, y, { steps: 24 });
};

const clickWithCursor = async (
  page: Page,
  x: number,
  y: number
): Promise<void> => {
  await moveCursor(page, x, y);
  await dwell(250);
  await page.mouse.click(x, y);
};

const clickLocator = async (page: Page, selector: string): Promise<void> => {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 45_000 });
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`No bounding box for ${selector}`);
  }
  await clickWithCursor(page, box.x + box.width / 2, box.y + box.height / 2);
};

const waitForSearchReady = async (page: Page): Promise<void> => {
  const gate = page.getByRole("heading", {
    name: "Log in om opdrachten te bekijken",
  });
  const results = page.getByLabel("Zoekresultaten");
  const unavailable = page.getByText("tijdelijk niet beschikbaar");
  await Promise.race([
    results.waitFor({ state: "visible", timeout: 45_000 }),
    gate.waitFor({ state: "visible", timeout: 45_000 }),
    unavailable.waitFor({ state: "visible", timeout: 45_000 }),
  ]);
  if (await gate.isVisible().catch(() => false)) {
    throw new Error("Search still shows the auth gate after sign-in.");
  }
  if (await unavailable.isVisible().catch(() => false)) {
    throw new Error("Search shows temporary unavailable (likely auth miss).");
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
  await moveCursor(page, 640, 360);
  await page.getByLabel("Email").click();
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").click();
  await page.getByLabel("Password").fill(credentials.password);
  await clickLocator(page, 'button:has-text("Sign In")');
  await page.waitForURL(/\/(?:dashboard)?\/?(?:\?.*)?$/u, { timeout: 30_000 });
};

const cueGapMs = (fromLabel: string, toLabel: string): number => {
  const from = DEMO_NARRATION_CUES.find((cue) => cue.label === fromLabel);
  const to = DEMO_NARRATION_CUES.find((cue) => cue.label === toLabel);
  if (!(from && to)) {
    return 2000;
  }
  return Math.max(800, Math.round((to.at - from.at) * 1000));
};

const runTour = async (
  page: Page,
  credentials: DemoCredentials,
  query: string
): Promise<void> => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByText("Job Intelligence")
    .first()
    .waitFor({ state: "visible" });
  await moveCursor(page, 200, 160);
  await dwell(cueGapMs("home", "login"));

  await signIn(page, credentials);
  await dwell(cueGapMs("login", "jobs"));

  await page.goto(`/jobs?q=${encodeURIComponent(query)}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForSearchReady(page);
  await moveCursor(page, 420, 220);
  await dwell(Math.max(2500, cueGapMs("jobs", "detail") - 1500));

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
  await moveCursor(page, 980, 320);
  await dwell(cueGapMs("detail", "bronnen"));

  await page.goto("/bronnen", { waitUntil: "domcontentloaded" });
  const forbidden = page.url().includes("toast=forbidden");
  if (forbidden) {
    await dwell(cueGapMs("bronnen", "dashboard"));
  } else {
    await page.getByRole("heading", { exact: true, name: "Bronnen" }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await moveCursor(page, 240, 280);
    await dwell(cueGapMs("bronnen", "runs"));
    await page.goto("/bronnen/runs", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");
    await moveCursor(page, 360, 360);
    await dwell(cueGapMs("runs", "dashboard"));
  }

  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await page
    .getByText(/^Welcome /u)
    .waitFor({ state: "visible", timeout: 15_000 });
  await moveCursor(page, 1180, 40);
  await dwell(cueGapMs("dashboard", "signout"));

  // UserMenu trigger is the account name — not the theme toggle.
  const account = page.getByRole("button", { name: "Demo Operator" });
  await account.waitFor({ state: "visible", timeout: 15_000 });
  const menuBox = await account.boundingBox();
  await (menuBox
    ? clickWithCursor(
        page,
        menuBox.x + menuBox.width / 2,
        menuBox.y + menuBox.height / 2
      )
    : account.click());
  const signOut = page.getByRole("menuitem", { name: "Uitloggen" });
  await signOut.waitFor({ state: "visible", timeout: 10_000 });
  await signOut.click();
  await page.waitForURL(/\/(?:\?.*)?$/u, { timeout: 15_000 });
  await page.getByRole("button", { name: "Inloggen" }).waitFor({
    state: "visible",
  });
  await moveCursor(page, 640, 400);
  await dwell(2500);
};

const startX11Grab = (display: string, rawPath: string): GrabSession => {
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
        // Already exited.
      }
    },
    pid: proc.pid,
    rawPath,
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
    throw new Error("ffprobe failed reading duration.");
  }
  const text = new TextDecoder().decode(result.stdout).trim();
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("ffprobe returned a non-positive duration.");
  }
  return seconds;
};

const writeMeta = async (
  metaPath: string,
  preflight: DemoPreflightResult,
  durationSeconds: number,
  extras: Readonly<Record<string, string>>
): Promise<void> => {
  const pairs = Object.entries({
    app: preflight.appUrl,
    duration_s: durationSeconds.toFixed(1),
    tip: preflight.releaseSha,
    ...extras,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  await writeFile(metaPath, `${pairs}\n`, "utf-8");
};

const main = async (): Promise<void> => {
  const environment = process.env;
  const credentials = requireCredentials(environment);
  const targets = resolveDemoTargets(environment);
  const query = environment.JI_DEMO_QUERY?.trim() || DEFAULT_QUERY;
  const outDir = environment.JI_DEMO_OUT_DIR?.trim() || "demos";
  const display = environment.DISPLAY?.trim() || ":1";
  const voiceoverPath =
    environment.JI_DEMO_VOICEOVER?.trim() || DEFAULT_VOICEOVER;

  const preflight = await runDemoPreflight(targets);
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, ".tmp"), { recursive: true });

  const day = stamp();
  const baseName = `ji-feature-demo-ryan-${day}`;
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
    await runTour(page, credentials, query);
  } finally {
    await context.close();
    await browser.close();
    grab.kill();
    await dwell(1200);
  }

  if (!(await Bun.file(rawPath).exists())) {
    throw new Error("x11grab did not write a raw MP4.");
  }
  if (!(await Bun.file(voiceoverPath).exists())) {
    throw new Error(
      `Voiceover missing at ${voiceoverPath}. Generate with HeyGen Sharon (nl) or set JI_DEMO_VOICEOVER.`
    );
  }

  muxVoiceover(rawPath, voiceoverPath, mp4Path);
  const durationSeconds = probeDurationSeconds(mp4Path);
  await writeMeta(metaPath, preflight, durationSeconds, {
    cursor: "x11grab+overlay",
    voiceover: path.basename(voiceoverPath),
  });

  console.log(
    JSON.stringify(
      {
        cursor: "x11grab+overlay",
        durationSeconds,
        metaPath,
        mp4Path,
        ok: true,
        releaseSha: preflight.releaseSha,
        voiceoverPath,
      },
      null,
      2
    )
  );
};

if (import.meta.main) {
  await main();
}
