/* oxlint-disable eslint/complexity, eslint/no-await-in-loop, promise/avoid-new, anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- The tunnel owns a bounded serial readiness loop and intentionally wraps Bun's untyped subprocess boundary. */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_REMOTE_PORT = 8000;
const DEFAULT_LOCAL_PORT = 18_000;
const DEFAULT_SSH_PORT = 22;
const READINESS_ATTEMPTS = 30;
const READINESS_DELAY_MS = 200;
const CLEANUP_TIMEOUT_MS = 5000;

export interface TunnelProcess {
  readonly exited: Promise<number>;
  readonly kill: (signal?: "SIGTERM" | "SIGKILL") => void;
}

export interface TunnelSpawnOptions {
  readonly env: Record<string, string>;
  readonly stdin: "ignore";
  readonly stdout: "ignore" | "inherit";
  readonly stderr: "ignore" | "inherit";
}

export type SpawnProcess = (
  args: readonly string[],
  options: TunnelSpawnOptions
) => TunnelProcess;

export interface SshTunnelConfig {
  readonly command: readonly string[];
  readonly controlCheckImpl?: (
    args: readonly string[],
    env: Record<string, string>
  ) => Promise<boolean>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly host: string;
  readonly knownHosts: string;
  readonly localPort?: number;
  readonly privateKey: string;
  readonly remotePort?: number;
  readonly sshPort?: number;
  readonly user: string;
  readonly probeImpl?: (url: string) => Promise<boolean>;
  readonly sleepImpl?: (milliseconds: number) => Promise<void>;
  readonly spawnImpl?: SpawnProcess;
}

export class SshTunnelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "SshTunnelError";
    this.code = code;
  }
}

const requirePort = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new SshTunnelError("invalid_configuration", `${name} is invalid`);
  }
  return value;
};

const requireText = (value: string, name: string): string => {
  if (value.trim().length === 0 || /[\0\n\r]/u.test(value)) {
    throw new SshTunnelError("invalid_configuration", `${name} is invalid`);
  }
  return value;
};

const requireSecret = (value: string, name: string): string => {
  if (value.trim().length === 0 || /\0/u.test(value)) {
    throw new SshTunnelError("invalid_configuration", `${name} is invalid`);
  }
  return value;
};

export const buildSshArguments = (
  config: Pick<
    SshTunnelConfig,
    | "host"
    | "knownHosts"
    | "localPort"
    | "privateKey"
    | "remotePort"
    | "sshPort"
    | "user"
  > & { readonly controlPath: string; readonly keyFile: string }
): readonly string[] => {
  const host = requireText(config.host, "COOLIFY_SSH_HOST");
  const user = requireText(config.user, "COOLIFY_SSH_USER");
  const keyFile = requireText(config.keyFile, "SSH key file");
  const knownHosts = requireText(config.knownHosts, "known-hosts file");
  const sshPort = requirePort(config.sshPort ?? DEFAULT_SSH_PORT, "SSH port");
  const localPort = requirePort(
    config.localPort ?? DEFAULT_LOCAL_PORT,
    "local tunnel port"
  );
  const remotePort = requirePort(
    config.remotePort ?? DEFAULT_REMOTE_PORT,
    "remote Coolify port"
  );
  return [
    "ssh",
    "-M",
    "-S",
    config.controlPath,
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    keyFile,
    "-p",
    String(sshPort),
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    `${user}@${host}`,
  ];
};

export const buildSshControlCheckArguments = (
  config: Pick<SshTunnelConfig, "host" | "sshPort" | "user"> & {
    readonly controlPath: string;
  }
): readonly string[] => [
  "ssh",
  "-S",
  config.controlPath,
  "-O",
  "check",
  "-p",
  String(config.sshPort ?? DEFAULT_SSH_PORT),
  "-o",
  "BatchMode=yes",
  `${config.user}@${config.host}`,
];

export const tunnelApiBaseUrl = (localPort = DEFAULT_LOCAL_PORT): string => {
  requirePort(localPort, "local tunnel port");
  return `http://127.0.0.1:${localPort}/api/v1`;
};

const defaultSpawn: SpawnProcess = (args, options) =>
  Bun.spawn([...args], options) as unknown as TunnelProcess;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
};

const toEnvironment = (
  env: Readonly<Record<string, string | undefined>> | undefined
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env ?? process.env)) {
    if (value !== undefined) {
      result[name] = value;
    }
  }
  delete result.COOLIFY_SSH_PRIVATE_KEY;
  delete result.COOLIFY_SSH_KNOWN_HOSTS;
  return result;
};

const toChildEnvironment = (
  env: Readonly<Record<string, string | undefined>> | undefined,
  apiBaseUrl: string
): Record<string, string> => {
  const result = toEnvironment(env);
  result.COOLIFY_API_BASE_URL = apiBaseUrl;
  return result;
};

const cleanupProcess = async (process: TunnelProcess): Promise<void> => {
  try {
    process.kill("SIGTERM");
  } catch {
    return;
  }
  const waitExited = async (): Promise<boolean> => {
    try {
      await process.exited;
      return true;
    } catch {
      return true;
    }
  };
  const waitTimeout = async (): Promise<boolean> => {
    await defaultSleep(CLEANUP_TIMEOUT_MS);
    return false;
  };
  const exited = await Promise.race([waitExited(), waitTimeout()]);
  if (!exited) {
    try {
      process.kill("SIGKILL");
    } catch {
      return;
    }
    if (!(await Promise.race([waitExited(), waitTimeout()]))) {
      throw new SshTunnelError(
        "cleanup_unresolved",
        "owned process did not exit after SIGKILL"
      );
    }
  }
};

const cleanupDirectory = async (directory: string): Promise<void> => {
  await rm(directory, { force: true, recursive: true });
};

export const runWithSshTunnel = async (
  config: SshTunnelConfig
): Promise<number> => {
  if (config.command.length === 0) {
    throw new SshTunnelError("invalid_configuration", "command is required");
  }
  const localPort = requirePort(
    config.localPort ?? DEFAULT_LOCAL_PORT,
    "local tunnel port"
  );
  requireSecret(config.privateKey, "COOLIFY_SSH_PRIVATE_KEY");
  requireSecret(config.knownHosts, "COOLIFY_SSH_KNOWN_HOSTS");
  const directory = await mkdtemp(path.join(tmpdir(), "ji-coolify-ssh-"));
  const keyFile = path.join(directory, "id_ed25519");
  const knownHostsFile = path.join(directory, "known_hosts");
  const controlPath = path.join(directory, "control.sock");
  let tunnelProcess: TunnelProcess | undefined;
  let childProcess: TunnelProcess | undefined;
  let childExited = false;
  let result: number | undefined;
  let primaryError: unknown;
  let signalRequested: string | undefined;
  const onSignal = (signal: string): void => {
    signalRequested ??= signal;
    try {
      childProcess?.kill("SIGTERM");
    } catch {
      // The finally block still attempts the owned-process cleanup.
    }
    try {
      tunnelProcess?.kill("SIGTERM");
    } catch {
      // The finally block still attempts the owned-process cleanup.
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await writeFile(keyFile, config.privateKey, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await chmod(keyFile, 0o600);
    await writeFile(knownHostsFile, config.knownHosts, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await chmod(knownHostsFile, 0o600);
    const sshArguments = buildSshArguments({
      controlPath,
      host: config.host,
      keyFile,
      knownHosts: knownHostsFile,
      localPort,
      privateKey: config.privateKey,
      remotePort: config.remotePort,
      sshPort: config.sshPort,
      user: config.user,
    });
    const controlCheckArguments = buildSshControlCheckArguments({
      controlPath,
      host: config.host,
      sshPort: config.sshPort,
      user: config.user,
    });
    tunnelProcess = (config.spawnImpl ?? defaultSpawn)(sshArguments, {
      env: toEnvironment(config.env),
      stderr: "inherit",
      stdin: "ignore",
      stdout: "ignore",
    });
    let exitCode: number | undefined;
    const observeExit = async (): Promise<void> => {
      const code = await tunnelProcess?.exited;
      exitCode = code;
    };
    void observeExit();
    const probe = config.probeImpl ?? defaultProbe;
    const sleep = config.sleepImpl ?? defaultSleep;
    const controlCheck =
      config.controlCheckImpl ??
      (async (args: readonly string[], env: Record<string, string>) => {
        const control = defaultSpawn(args, {
          env,
          stderr: "ignore",
          stdin: "ignore",
          stdout: "ignore",
        });
        return (await control.exited) === 0;
      });
    const awaitChild = async (): Promise<number> => {
      const code = await childProcess?.exited;
      childExited = true;
      return code ?? 1;
    };
    for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
      if (signalRequested) {
        throw new SshTunnelError(
          "cancelled",
          `SSH tunnel run was interrupted by ${signalRequested}`
        );
      }
      if (exitCode !== undefined) {
        throw new SshTunnelError(
          "tunnel_start_failed",
          `ssh exited with status ${exitCode}`
        );
      }
      if (
        (await controlCheck(
          controlCheckArguments,
          toEnvironment(config.env)
        )) &&
        (await probe(tunnelApiBaseUrl(localPort)))
      ) {
        childProcess = (config.spawnImpl ?? defaultSpawn)(config.command, {
          env: toChildEnvironment(config.env, tunnelApiBaseUrl(localPort)),
          stderr: "inherit",
          stdin: "ignore",
          stdout: "inherit",
        });
        result = await awaitChild();
        if (signalRequested) {
          throw new SshTunnelError(
            "cancelled",
            `SSH tunnel run was interrupted by ${signalRequested}`
          );
        }
        break;
      }
      await sleep(READINESS_DELAY_MS);
    }
    if (result === undefined) {
      throw new SshTunnelError(
        "tunnel_timeout",
        "SSH tunnel did not become ready"
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (childProcess && !childExited) {
        await cleanupProcess(childProcess);
      }
    } catch (error) {
      primaryError ??= error;
    } finally {
      try {
        if (tunnelProcess) {
          await cleanupProcess(tunnelProcess);
        }
      } catch (error) {
        primaryError ??= error;
      } finally {
        try {
          await cleanupDirectory(directory);
        } catch (error) {
          primaryError ??= error;
        }
      }
    }
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  if (primaryError !== undefined) {
    throw primaryError;
  }
  return result ?? 1;
};

const readRequired = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new SshTunnelError("missing_configuration", `${name} is required`);
  }
  return value;
};

/**
 * The command to run behind the tunnel is everything after `--`, or, when the
 * runtime already consumed that separator (bun drops a `--` that directly
 * follows the script path), everything after the script path itself.
 */
export const commandFromArgv = (argv: readonly string[]): string[] => {
  const separator = argv.indexOf("--");
  return separator === -1 ? argv.slice(2) : argv.slice(separator + 1);
};

const main = async (): Promise<void> => {
  const command = commandFromArgv(process.argv);
  if (command.length === 0) {
    throw new SshTunnelError("invalid_configuration", "command is required");
  }
  const exitCode = await runWithSshTunnel({
    command,
    env: process.env,
    host: readRequired("COOLIFY_SSH_HOST"),
    knownHosts: readRequired("COOLIFY_SSH_KNOWN_HOSTS"),
    localPort: Number(process.env.COOLIFY_SSH_LOCAL_PORT || DEFAULT_LOCAL_PORT),
    privateKey: readRequired("COOLIFY_SSH_PRIVATE_KEY"),
    remotePort: Number(
      process.env.COOLIFY_SSH_REMOTE_PORT || DEFAULT_REMOTE_PORT
    ),
    sshPort: Number(process.env.COOLIFY_SSH_PORT || DEFAULT_SSH_PORT),
    user: readRequired("COOLIFY_SSH_USER"),
  });
  process.exitCode = exitCode;
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        reason:
          error instanceof SshTunnelError
            ? error.message
            : "ssh_tunnel_failed: unexpected error",
        result: "block",
      })
    );
    process.exitCode = 1;
  }
}
