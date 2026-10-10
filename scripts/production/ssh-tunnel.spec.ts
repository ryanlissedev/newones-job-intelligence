import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
/* oxlint-disable eslint/require-await, eslint/no-plusplus, promise/avoid-new, anti-slop/no-unknown-parameters -- The fake subprocess is a bounded protocol fixture for tunnel argument, secret-scope, and cleanup behavior. */
import { existsSync, statSync } from "node:fs";

import {
  buildSshArguments,
  buildSshControlCheckArguments,
  commandFromArgv,
  runWithSshTunnel,
  tunnelApiBaseUrl,
} from "./ssh-tunnel";
import type { SpawnProcess, TunnelProcess } from "./ssh-tunnel";

const must = <T>(value: T | undefined, reason: string): T => {
  if (value === undefined) {
    throw new Error(reason);
  }
  return value;
};

const { privateKey: fakePrivateKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "der", type: "spki" },
});
const fakeKnownHosts =
  "coolify.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAfake";

describe("production Coolify SSH tunnel", () => {
  it("builds a pinned host-key, local-only forward", () => {
    expect(
      buildSshArguments({
        controlPath: "/tmp/control.sock",
        host: "coolify.example",
        keyFile: "/tmp/key",
        knownHosts: "/tmp/known_hosts",
        localPort: 18_000,
        privateKey: fakePrivateKey,
        remotePort: 8000,
        sshPort: 22,
        user: "deploy",
      })
    ).toEqual([
      "ssh",
      "-M",
      "-S",
      "/tmp/control.sock",
      "-N",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/tmp/known_hosts",
      "-o",
      "IdentitiesOnly=yes",
      "-i",
      "/tmp/key",
      "-p",
      "22",
      "-L",
      "127.0.0.1:18000:127.0.0.1:8000",
      "deploy@coolify.example",
    ]);
    expect(
      buildSshControlCheckArguments({
        controlPath: "/tmp/control.sock",
        host: "coolify.example",
        sshPort: 22,
        user: "deploy",
      })
    ).toEqual([
      "ssh",
      "-S",
      "/tmp/control.sock",
      "-O",
      "check",
      "-p",
      "22",
      "-o",
      "BatchMode=yes",
      "deploy@coolify.example",
    ]);
    expect(tunnelApiBaseUrl()).toBe("http://127.0.0.1:18000/api/v1");
  });

  it("keeps the key process-scoped and cleans the tunnel and temporary files", async () => {
    const calls: { args: readonly string[]; env: Record<string, string> }[] =
      [];
    let killCalls = 0;
    const tunnel: TunnelProcess = {
      exited: Promise.resolve(0),
      kill: () => {
        killCalls += 1;
        throw new Error("simulated cleanup failure");
      },
    };
    const child: TunnelProcess = {
      exited: Promise.resolve(17),
      kill: () => {},
    };
    const spawnImpl: SpawnProcess = (args, options) => {
      calls.push({ args, env: options.env });
      if (args[0] === "ssh") {
        const keyPath = must(
          args[args.indexOf("-i") + 1],
          "ssh was spawned without an -i identity file argument"
        );
        expect(existsSync(keyPath)).toBe(true);
        expect(statSync(keyPath).mode % 0o1000).toBe(0o600);
        return tunnel;
      }
      return child;
    };

    const exitCode = await runWithSshTunnel({
      command: ["bun", "scripts/production/coolify-deploy.ts"],
      controlCheckImpl: async () => true,
      env: {
        COOLIFY_SSH_KNOWN_HOSTS: fakeKnownHosts,
        COOLIFY_SSH_PRIVATE_KEY: fakePrivateKey,
        EXISTING: "kept",
      },
      host: "coolify.example",
      knownHosts: fakeKnownHosts,
      privateKey: fakePrivateKey,
      probeImpl: async () => true,
      spawnImpl,
      user: "deploy",
    });

    expect(exitCode).toBe(17);
    expect(calls).toHaveLength(2);
    const deployCall = must(
      calls[1],
      "the deployment command was never spawned"
    );
    expect(deployCall.env).toEqual({
      COOLIFY_API_BASE_URL: "http://127.0.0.1:18000/api/v1",
      EXISTING: "kept",
    });
    const tunnelCall = must(calls[0], "the ssh tunnel was never spawned");
    const keyPath = must(
      tunnelCall.args[tunnelCall.args.indexOf("-i") + 1],
      "ssh was spawned without an -i identity file argument"
    );
    expect(existsSync(keyPath)).toBe(false);
    expect(killCalls).toBe(1);
  });

  it("does not launch the deployment when the SSH-owned forward cannot establish", async () => {
    let childLaunches = 0;
    const tunnel: TunnelProcess = {
      exited: Promise.resolve(255),
      kill: () => {},
    };
    const spawnImpl: SpawnProcess = (args) => {
      if (args[0] !== "ssh") {
        childLaunches += 1;
      }
      return tunnel;
    };

    await expect(
      runWithSshTunnel({
        command: ["bun", "scripts/production/coolify-deploy.ts"],
        controlCheckImpl: async () => false,
        host: "coolify.example",
        knownHosts: fakeKnownHosts,
        privateKey: fakePrivateKey,
        probeImpl: async () => true,
        sleepImpl: async () => {},
        spawnImpl,
        user: "deploy",
      })
    ).rejects.toThrow("tunnel_start_failed");
    expect(childLaunches).toBe(0);
  });
});

describe("commandFromArgv", () => {
  it("takes everything after the separator when it survives", () => {
    expect(
      commandFromArgv(["bun", "ssh-tunnel.ts", "--", "bun", "deploy.ts"])
    ).toEqual(["bun", "deploy.ts"]);
  });

  it("takes everything after the script path when the runtime dropped the separator", () => {
    expect(
      commandFromArgv(["bun", "ssh-tunnel.ts", "bun", "deploy.ts"])
    ).toEqual(["bun", "deploy.ts"]);
  });

  it("is empty when nothing follows", () => {
    expect(commandFromArgv(["bun", "ssh-tunnel.ts"])).toEqual([]);
    expect(commandFromArgv(["bun", "ssh-tunnel.ts", "--"])).toEqual([]);
  });
});
