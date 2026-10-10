import { spawnSync } from "node:child_process";

interface ComposePort {
  target?: number;
  published?: number | string;
  host_ip?: string;
  protocol?: string;
}

interface ComposeVolumeMount {
  type?: string;
  source?: string;
  target?: string;
  bind?: {
    read_only?: boolean;
  };
}

interface ComposeService {
  ports?: (number | string | ComposePort)[];
  cpus?: string;
  mem_limit?: string;
  mem_reservation?: string;
  volumes?: (string | ComposeVolumeMount)[];
  healthcheck?: {
    test?: string | string[];
  };
}

interface ComposeVolume {
  external?: boolean;
  name?: string;
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, ComposeVolume>;
}

const isComposePort = (
  entry: number | string | ComposePort
): entry is ComposePort =>
  Object.hasOwn(entry, "target") || Object.hasOwn(entry, "host_ip");

const normalizePorts = (
  ports: ComposeService["ports"] | undefined
): ComposePort[] => {
  if (!ports) {
    return [];
  }

  return ports.map((entry) => {
    if (isComposePort(entry)) {
      return entry;
    }

    if (Number.isInteger(entry)) {
      return { published: entry, target: entry };
    }

    const [published, target] = entry.split(":");
    return {
      published: Number(published),
      target: Number(target ?? published),
    };
  });
};

const memoryLimitPattern = /^(?<amount>\d+(?:\.\d+)?)(?<unit>[kmg])?b?$/iu;

const parseMemoryLimitMegabytes = (
  value: string | undefined
): number | null => {
  if (!value) {
    return null;
  }

  const match = memoryLimitPattern.exec(value.trim());
  if (!match?.groups?.amount) {
    return null;
  }

  const amount = Number(match.groups.amount);
  const unit = (match.groups.unit ?? "m").toLowerCase();

  switch (unit) {
    case "g": {
      return amount * 1024;
    }
    case "m": {
      return amount;
    }
    case "k": {
      return amount / 1024;
    }
    default: {
      return null;
    }
  }
};

// SAFETY: compose YAML uses string bind mounts; `docker compose config --format json` uses objects with a `type` field.
const isStringVolumeMount = (
  volume: string | ComposeVolumeMount
): volume is string => !Object.hasOwn(volume, "type");

const isReadOnlyManticoreConfMount = (
  volume: string | ComposeVolumeMount
): boolean => {
  if (isStringVolumeMount(volume)) {
    return volume.includes("manticore.conf") && /:ro(?:$|:)/u.test(volume);
  }

  return (
    volume.type === "bind" &&
    volume.target?.includes("manticore.conf") === true &&
    volume.bind?.read_only === true
  );
};

const validateManticoreCompose = (
  manticore: ComposeService | undefined,
  postgresMemory: number | null
): string[] => {
  const violations: string[] = [];
  const manticoreMemory = parseMemoryLimitMegabytes(manticore?.mem_limit);

  if (manticoreMemory === null) {
    violations.push("manticore service must declare mem_limit");
  }

  if (
    postgresMemory !== null &&
    manticoreMemory !== null &&
    postgresMemory <= manticoreMemory
  ) {
    violations.push(
      `postgres mem_limit (${postgresMemory}m) must exceed manticore mem_limit (${manticoreMemory}m)`
    );
  }

  for (const volume of manticore?.volumes ?? []) {
    if (isReadOnlyManticoreConfMount(volume)) {
      violations.push(
        "manticore manticore.conf bind mount must not use :ro; the image entrypoint chowns /etc/manticoresearch before searchd starts"
      );
    }
  }

  const healthcheckCommand = manticore?.healthcheck?.test;
  const healthcheckParts = Array.isArray(healthcheckCommand)
    ? healthcheckCommand.join(" ")
    : (healthcheckCommand ?? "");

  if (
    healthcheckParts.includes("SHOW TABLES") &&
    !healthcheckParts.includes("aanvragen")
  ) {
    violations.push(
      "manticore healthcheck must assert the aanvragen RT table from tools/manticore/manticore.conf is loaded"
    );
  }

  return violations;
};

export const validatePostgresCompose = (
  document: ComposeDocument
): string[] => {
  const violations: string[] = [];
  const postgres = document.services?.postgres;
  const manticore = document.services?.manticore;
  const postgresVolume = document.volumes?.postgres_data;

  if (!postgres) {
    violations.push("docker-compose.yml must define a postgres service");
    return violations;
  }

  if (!postgresVolume?.external) {
    violations.push(
      "volumes.postgres_data must be external: true so compose lifecycle cannot destroy production data"
    );
  }

  if (!postgresVolume?.name) {
    violations.push(
      "volumes.postgres_data must declare a named external volume via POSTGRES_DATA_VOLUME"
    );
  }

  for (const port of normalizePorts(postgres.ports)) {
    if (port.target !== 5432 && port.published !== 5432) {
      continue;
    }

    const hostIp = port.host_ip ?? "0.0.0.0";
    if (hostIp !== "127.0.0.1") {
      violations.push(
        `postgres port 5432 must bind to host_ip 127.0.0.1, found '${hostIp}'`
      );
    }
  }

  const postgresMemory = parseMemoryLimitMegabytes(postgres.mem_limit);

  if (postgresMemory === null) {
    violations.push(
      "postgres service must declare mem_limit for DB-first budgeting"
    );
  }

  violations.push(...validateManticoreCompose(manticore, postgresMemory));

  return violations;
};

const readComposeDocument = (): ComposeDocument => {
  const result = spawnSync(
    "docker",
    ["compose", "--env-file", ".env.example", "config", "--format", "json"],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
    }
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr || "docker compose config failed; is Docker available?"
    );
  }

  if (!result.stdout) {
    throw new Error("docker compose config returned empty output");
  }

  // SAFETY: docker compose config --format json returns a Compose schema document.
  return JSON.parse(result.stdout) as ComposeDocument;
};

export const runPostgresComposeCheck = (): void => {
  const violations = validatePostgresCompose(readComposeDocument());

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`check-postgres-compose: ${violation}`);
    }
    process.exit(1);
  }

  console.log("check-postgres-compose: passed");
};

if (import.meta.main) {
  runPostgresComposeCheck();
}
