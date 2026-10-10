#!/usr/bin/env bun
/**
 * Launch, doctor, HTTP-drive, and stop a Catapulze Job Intelligence verification instance.
 * Invoke from the repository root. Never kill by process name — only PIDs this script recorded.
 */
import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SKILL_DIR, "../../..");
const RUN_DIR = join(SKILL_DIR, ".run");
const ARTIFACTS_DIR = join(SKILL_DIR, "artifacts");
const PID_FILE = join(RUN_DIR, "pids.json");
const SERVER_URL = "http://localhost:3000";
const WEB_URL = "http://localhost:3001";
const READY_MS = 90_000;

const usage = `Usage: bun .cursor/skills/verify-job-intelligence/scripts/control.mjs <command>

  launch     Start server (3000) and web (3001) if we do not already own them
  doctor     Read-only health: ports, GET /, tRPC healthCheck
  stop       Kill only PIDs recorded by launch
  snapshot   Save home HTML + tRPC body under artifacts/<feature-id>/
  drive      Browser-drive all feature recipes (requires launch + doctor)
  http       GET a URL (pass the URL as the next argument)
`;

const binPath = () =>
  `${join(REPO_ROOT, "node_modules", ".bin")}:${process.env.PATH ?? ""}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const httpGet = async (url, extraHeaders = {}) => {
  const response = await fetch(url, {
    headers: { Accept: "text/html,application/json,*/*", ...extraHeaders },
    redirect: "manual",
  });
  const body = await response.text();
  return { body, status: response.status, headers: response.headers };
};

const loadPids = async () => {
  try {
    return JSON.parse(await readFile(PID_FILE, "utf8"));
  } catch {
    return null;
  }
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const portOwnerIsOurs = async () => {
  const pids = await loadPids();
  if (!pids) {
    return false;
  }
  return pidAlive(pids.server) && pidAlive(pids.web);
};

const waitFor = async (url, predicate, label) => {
  const deadline = Date.now() + READY_MS;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = await httpGet(url);
      last = `${result.status} ${result.body.slice(0, 80)}`;
      if (predicate(result)) {
        return;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(`${label} not ready at ${url} (${last})`);
};

const spawnDev = (script, logName) => {
  const logPath = join(RUN_DIR, logName);
  const logFd = openSync(logPath, "a");
  const child = spawn("bun", ["run", script], {
    cwd: REPO_ROOT,
    detached: true,
    env: { ...process.env, PATH: binPath() },
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child;
};

const launch = async () => {
  await mkdir(RUN_DIR, { recursive: true });
  if (await portOwnerIsOurs()) {
    console.log("Already launched by this skill; doctor instead of starting again.");
    return;
  }
  try {
    await httpGet(`${SERVER_URL}/`);
    throw new Error(
      `Port 3000 already answers but is not this skill's instance. Refuse to double-drive. Stop the other process or doctor it only with JI_VERIFY_ALLOW_SHARED=1.`
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("Refuse")) {
      throw error;
    }
  }
  try {
    await httpGet(`${WEB_URL}/`);
    throw new Error(
      `Port 3001 already answers but is not this skill's instance. Refuse to double-drive.`
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("Refuse")) {
      throw error;
    }
  }

  const server = spawnDev("dev:server", "server.log");
  const web = spawnDev("dev:web", "web.log");
  await writeFile(
    PID_FILE,
    `${JSON.stringify({ server: server.pid, web: web.pid, startedAt: new Date().toISOString() }, null, 2)}\n`
  );
  await waitFor(`${SERVER_URL}/`, (r) => r.status === 200 && r.body.trim() === "OK", "server");
  await waitFor(`${WEB_URL}/`, (r) => r.status === 200 && r.body.includes("Job Intelligence"), "web");
  console.log(`Launched server pid ${server.pid} and web pid ${web.pid}`);
};

const doctor = async () => {
  const pids = await loadPids();
  const ours = await portOwnerIsOurs();
  const sharedOk = process.env.JI_VERIFY_ALLOW_SHARED === "1";
  const server = await httpGet(`${SERVER_URL}/`);
  const web = await httpGet(`${WEB_URL}/`);
  const health = await httpGet(`${SERVER_URL}/trpc/healthCheck`);
  const dashboard = await httpGet(`${WEB_URL}/dashboard`);
  const report = {
    artifactsDir: ARTIFACTS_DIR,
    dashboardLocation: dashboard.headers.get("location"),
    dashboardStatus: dashboard.status,
    healthBody: health.body.slice(0, 200),
    healthStatus: health.status,
    ours,
    pids,
    serverBody: server.body.trim(),
    serverStatus: server.status,
    webHasTitle: web.body.includes("Job Intelligence"),
    webStatus: web.status,
  };
  const healthy =
    server.status === 200 &&
    server.body.trim() === "OK" &&
    web.status === 200 &&
    web.body.includes("Job Intelligence") &&
    health.status === 200 &&
    health.body.includes("OK");
  if (!healthy) {
    console.log(JSON.stringify(report, null, 2));
    throw new Error("doctor failed: instance is not worth driving");
  }
  if (!(ours || sharedOk)) {
    console.log(JSON.stringify(report, null, 2));
    throw new Error(
      "doctor: ports are healthy but not owned by this skill. Set JI_VERIFY_ALLOW_SHARED=1 for read-only driving of a user-started instance."
    );
  }
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
};

const stop = async () => {
  const pids = await loadPids();
  if (!pids) {
    console.log("No pidfile; nothing to stop.");
    return;
  }
  for (const pid of [pids.web, pids.server]) {
    if (typeof pid === "number" && pidAlive(pid)) {
      process.kill(-pid, "SIGTERM");
    }
  }
  await sleep(500);
  for (const pid of [pids.web, pids.server]) {
    if (typeof pid === "number" && pidAlive(pid)) {
      process.kill(-pid, "SIGKILL");
    }
  }
  await rm(PID_FILE, { force: true });
  console.log("Stopped verification instance. Evidence under artifacts/ was kept.");
};

const snapshot = async (name = "home-command-center") => {
  const dir = join(ARTIFACTS_DIR, name);
  await mkdir(dir, { recursive: true });
  const home = await httpGet(`${WEB_URL}/`);
  const health = await httpGet(`${SERVER_URL}/trpc/healthCheck`);
  const root = await httpGet(`${SERVER_URL}/`);
  await writeFile(join(dir, "home.html"), home.body);
  await writeFile(join(dir, "trpc-healthCheck.txt"), health.body);
  await writeFile(join(dir, "server-root.txt"), root.body);
  await writeFile(
    join(dir, "meta.json"),
    `${JSON.stringify(
      {
        feature: name,
        healthStatus: health.status,
        homeStatus: home.status,
        serverRoot: root.body.trim(),
        capturedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
  console.log(`Wrote ${dir}`);
};

const command = process.argv[2];
try {
  switch (command) {
    case "launch":
      await launch();
      break;
    case "doctor":
      await doctor();
      break;
    case "stop":
      await stop();
      break;
    case "snapshot":
      await snapshot(process.argv[3] ?? "home-command-center");
      break;
    case "http": {
      const url = process.argv[3];
      if (!url) {
        throw new Error("http requires a URL");
      }
      const result = await httpGet(url);
      console.log(`${result.status}\n${result.body}`);
      break;
    }
    case "drive": {
      const driveScript = join(SKILL_DIR, "scripts", "drive.mjs");
      const result = spawnSync("bun", [driveScript], {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: "inherit",
      });
      process.exit(result.status ?? 1);
      break;
    }
    default:
      console.log(usage);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
