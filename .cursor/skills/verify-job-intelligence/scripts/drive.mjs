#!/usr/bin/env bun
/**
 * Browser drive for verify-job-intelligence features. Requires launch + doctor first.
 * Writes proof under artifacts/<feature-id>/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(SKILL_DIR, "artifacts");
const WEB = "http://localhost:3001";
const API = "http://localhost:3000";
const RUN_ID = Date.now().toString();

const writeMeta = async (feature, extra) => {
  const dir = join(ARTIFACTS, feature);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "meta.json"),
    `${JSON.stringify({ feature, capturedAt: new Date().toISOString(), ...extra }, null, 2)}\n`
  );
  return dir;
};

const saveShot = async (page, dir, name) => {
  await page.screenshot({ path: join(dir, name), fullPage: true });
};

const driveHome = async (page) => {
  const dir = await writeMeta("home-command-center", { runId: RUN_ID });
  await page.goto(`${WEB}/`, { waitUntil: "networkidle" });
  await page.getByText("Vind de juiste opdracht").waitFor({ state: "visible" });
  await saveShot(page, dir, "home.png");
  const html = await page.content();
  await writeFile(join(dir, "home-browser.html"), html);
  await page.getByRole("link", { name: "Open job search" }).click();
  await page.waitForURL("**/jobs**");
  await saveShot(page, dir, "cta-jobs.png");
};

const driveJobSearch = async (page) => {
  const dir = await writeMeta("job-search", {
    runId: RUN_ID,
    fixtures: true,
    query: "Azure",
  });
  await page.goto(`${WEB}/jobs?q=Azure&freshness=30d`);
  await page
    .getByLabel("Zoek opdrachten met Boolean-logica")
    .waitFor({ state: "visible" });
  await page.getByLabel("Zoekresultaten").waitFor({ state: "visible" });
  await saveShot(page, dir, "jobs-results.png");
  const resultButton = page.getByLabel("Zoekresultaten").locator("table tbody button").first();
  if (await resultButton.count()) {
    await resultButton.click();
    await page.waitForURL(/job=/);
    await saveShot(page, dir, "jobs-detail.png");
  }
  await page.getByRole("checkbox", { name: "Ook in archief zoeken" }).check();
  await page.waitForURL(/archief=1/);
  await saveShot(page, dir, "jobs-archief-url.png");
};

const driveDashboardGuard = async (page, context) => {
  const dir = await writeMeta("dashboard-guard", { runId: RUN_ID });
  await context.clearCookies();
  const response = await page.goto(`${WEB}/dashboard`);
  const finalUrl = page.url();
  await writeFile(
    join(dir, "redirect.txt"),
    `status=${response?.status()}\nfinalUrl=${finalUrl}\n`
  );
  await page.getByRole("heading", { name: "Welcome Back" }).waitFor();
  await saveShot(page, dir, "login-after-guard.png");
  const body = await page.content();
  if (body.includes("Create Account")) {
    throw new Error("dashboard-guard: unexpected Create Account on login");
  }
};

const driveSignUpDisabled = async (page) => {
  const dir = await writeMeta("sign-up", {
    runId: RUN_ID,
    disableSignUp: true,
  });
  await page.goto(`${WEB}/login`);
  await page.getByRole("heading", { name: "Welcome Back" }).waitFor();
  const html = await page.content();
  await writeFile(join(dir, "login.html"), html);
  await saveShot(page, dir, "login-no-signup.png");
  for (const forbidden of ["Create Account", "Sign Up", "Need an account? Sign Up"]) {
    if (html.includes(forbidden)) {
      throw new Error(`sign-up: found forbidden copy "${forbidden}"`);
    }
  }
  const api = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Verify User",
      email: `verify+disabled-${RUN_ID}@example.test`,
      password: "verify-pass-8",
    }),
  });
  const apiBody = await api.text();
  await writeFile(
    join(dir, "signup-api-response.txt"),
    `status=${api.status}\n${apiBody}\n`
  );
  if (api.ok) {
    throw new Error("sign-up: API accepted public sign-up");
  }
};

const driveSignInShell = async (page) => {
  const dir = await writeMeta("sign-in-and-sign-out", {
    runId: RUN_ID,
    signinSubmit: "verified-unreachable",
    signout: "verified-unreachable",
    unreachablePrerequisite:
      "provisioned account via auth:provision or AUTH_BOOTSTRAP — no user in local DB for this run",
  });
  await page.goto(`${WEB}/login`);
  await page.getByRole("heading", { name: "Welcome Back" }).waitFor();
  await page.getByLabel("Email").waitFor();
  await page.getByLabel("Password").waitFor();
  await page.getByRole("button", { name: "Sign In" }).waitFor();
  await saveShot(page, dir, "signin-shell.png");
  const html = await page.content();
  if (html.includes("Already have an account? Sign In")) {
    throw new Error("sign-in: stale sign-up switch still present");
  }
};

const driveBronnenGuard = async (page, context) => {
  const operatorUnreachable = {
    bronnenNavVisible: "verified-unreachable",
    bronnenOverviewOpen: "verified-unreachable",
    bronnenKpis: "verified-unreachable",
    bronnenWindowLinks: "verified-unreachable",
    bronnenRunsLink: "verified-unreachable",
    unreachablePrerequisite:
      "provisioned operator or admin account via auth:provision or AUTH_BOOTSTRAP — none in local DB for this run",
  };
  const dir = await writeMeta("bronnen-operator-dashboard", {
    runId: RUN_ID,
    ...operatorUnreachable,
  });
  await context.clearCookies();
  const response = await page.goto(`${WEB}/bronnen`);
  const finalUrl = page.url();
  await writeFile(
    join(dir, "redirect.txt"),
    `status=${response?.status()}\nfinalUrl=${finalUrl}\n`
  );
  if (!finalUrl.includes("toast=forbidden")) {
    throw new Error(
      `bronnen-guard: expected /?toast=forbidden redirect, got ${finalUrl}`
    );
  }
  await page.getByText("Vind de juiste opdracht").waitFor({ state: "visible" });
  const nav = page.getByRole("navigation", { name: "Hoofdnavigatie" });
  await nav.getByRole("link", { name: "Overzicht" }).waitFor();
  await nav.getByRole("link", { name: "Zoeken" }).waitFor();
  if (await nav.getByRole("link", { name: "Bronnen" }).count()) {
    throw new Error("bronnen-guard: Bronnen nav visible while signed out");
  }
  await saveShot(page, dir, "forbidden-home.png");
  const toast = page.getByText("Je hebt geen toegang tot de bronmonitor.");
  if (await toast.count()) {
    await toast.first().waitFor({ state: "visible", timeout: 5000 });
    await saveShot(page, dir, "forbidden-toast.png");
  }
};

const main = async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await driveHome(page);
    await driveJobSearch(page);
    await driveDashboardGuard(page, context);
    await driveSignUpDisabled(page);
    await driveSignInShell(page);
    await driveBronnenGuard(page, context);
    console.log("Drive complete. Artifacts under", ARTIFACTS);
  } finally {
    await browser.close();
  }
};

await main();
