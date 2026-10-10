/**
 * Smoke the cursor + voiceover pipeline against the public home page.
 * No credentials. Proves x11grab -draw_mouse, overlay ring, and VO mux.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "@playwright/test";
import type { Page } from "@playwright/test";

import { resolveDemoTargets, runDemoPreflight } from "./preflight";

const VIEWPORT = { height: 800, width: 1280 } as const;
const DEFAULT_VOICEOVER = "demos/.tmp/ji-demo-voiceover-nl.wav";
const SMOKE_SECONDS = 18;

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

const driveCursorPath = async (page: Page): Promise<void> => {
  const pathPoints = [
    [180, 140],
    [640, 360],
    [1100, 80],
    [400, 520],
    [900, 240],
    [200, 160],
    [720, 400],
    [320, 220],
  ] as const;

  const step = async (index: number): Promise<void> => {
    if (index >= pathPoints.length) {
      return;
    }
    const [x, y] = pathPoints[index];
    await page.mouse.move(x, y, { steps: 28 });
    await delay(900);
    await step(index + 1);
  };

  await step(0);
};

const main = async (): Promise<void> => {
  const environment = process.env;
  const targets = resolveDemoTargets(environment);
  const outDir = environment.JI_DEMO_OUT_DIR?.trim() || "demos";
  const display = environment.DISPLAY?.trim() || ":1";
  const voiceoverPath =
    environment.JI_DEMO_VOICEOVER?.trim() || DEFAULT_VOICEOVER;
  const preflight = await runDemoPreflight(targets);

  await mkdir(path.join(outDir, ".tmp"), { recursive: true });
  const rawPath = path.join(outDir, ".tmp", "cursor-vo-smoke-raw.mp4");
  const mp4Path = path.join(outDir, "cursor-vo-smoke.mp4");
  const metaPath = path.join(outDir, "cursor-vo-smoke.meta.txt");

  const displayId = display.replace(/^:/u, "");
  const grab = Bun.spawn({
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
      "-t",
      String(SMOKE_SECONDS),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "ultrafast",
      rawPath,
    ],
    stderr: "pipe",
    stdout: "ignore",
  });

  await delay(600);
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
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page
    .getByText("Job Intelligence")
    .first()
    .waitFor({ state: "visible" });

  // Keep the JI window on screen for the full grab window.
  await Promise.all([driveCursorPath(page), grab.exited]);

  await context.close();
  await browser.close();

  const mux = Bun.spawnSync({
    cmd: [
      "ffmpeg",
      "-y",
      "-i",
      rawPath,
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
      "-shortest",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((mux.exitCode ?? 1) !== 0) {
    throw new Error("smoke mux failed");
  }

  await writeFile(
    metaPath,
    `tip=${preflight.releaseSha} cursor=x11grab+overlay voiceover=${path.basename(voiceoverPath)} app=${preflight.appUrl}\n`,
    "utf-8"
  );

  console.log(
    JSON.stringify(
      {
        metaPath,
        mp4Path,
        ok: true,
        releaseSha: preflight.releaseSha,
      },
      null,
      2
    )
  );
};

if (import.meta.main) {
  await main();
}
