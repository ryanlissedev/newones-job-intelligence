import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Decision = "allow" | "log" | "block" | "approved";
type Command = string | readonly string[];

interface GateCase {
  readonly name: string;
  readonly command: Command;
  readonly decision: Decision;
  readonly category?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly fileContents?: string;
  readonly productionGateConfigContents?: string;
  readonly secrets?: readonly string[];
  readonly stdin?: string;
  readonly toolName?: string;
  readonly toolInput?: Readonly<{
    readonly file_path?: string;
    readonly notebook_path?: string;
    readonly path?: string;
  }>;
}

const today = "2026-10-11";
const repoRoot = path.resolve(import.meta.dir, "../..");
const hookPath = path.join(repoRoot, ".claude/hooks/production-gate.sh");
const settingsPath = path.join(repoRoot, ".claude/settings.json");

it("keeps the production hook Bash 3.2 compatible", () => {
  const hookSource = readFileSync(hookPath, "utf-8");
  for (const forbidden of [
    ",,}",
    "^^}",
    "mapfile",
    "readarray",
    "declare -A",
    "local -A",
  ]) {
    expect(hookSource).not.toContain(forbidden);
  }
});

it("keeps the production hook executable", () => {
  expect(() => accessSync(hookPath, constants.X_OK)).not.toThrow();
});

it("runs the executable production hook directly", () => {
  const result = spawnSync(hookPath, [], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpdir(),
      PRODUCTION_GATE_LOG: path.join(tmpdir(), "production-gate-direct.log"),
    },
    input: JSON.stringify({
      tool_input: { command: "gh run view 123" },
      tool_name: "Bash",
    }),
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
});

it("runs the gate for write and edit hooks", () => {
  // SAFETY: settings.json is the repository-owned Claude settings schema used by this hook.
  const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
    hooks: { PreToolUse: { matcher?: string }[] };
  };
  expect(settings.hooks.PreToolUse.map(({ matcher }) => matcher)).toContain(
    "Write|Edit|MultiEdit|NotebookEdit"
  );
});

const cases: GateCase[] = [
  {
    category: "production-script",
    command: "./rollback.sh",
    decision: "log",
    name: "rollback script is logged",
  },
  {
    category: "production-script",
    command: "/opt/ops/release_apps.sh",
    decision: "log",
    name: "release script is logged",
  },
  {
    category: "production-script",
    command: "bash migrate-only.sh",
    decision: "log",
    name: "migration script is logged",
  },
  {
    category: "production-driver",
    command: "bun scripts/production/coolify-deploy.ts",
    decision: "log",
    name: "Coolify driver is logged",
  },
  {
    category: "production-script",
    command: 'git commit -m "$(./rollback.sh)"',
    decision: "log",
    name: "substitution rollback is logged",
  },
  {
    category: "production-script",
    command: "cat rollback.sh | bash",
    decision: "log",
    name: "piped rollback is logged",
  },
  {
    category: "production-script",
    command: "source ./rollback.sh",
    decision: "log",
    name: "sourced rollback is logged",
  },
  {
    category: "production-script",
    command: "eval ./rollback.sh",
    decision: "log",
    name: "eval rollback is logged",
  },
  {
    command: "cat rollback.sh",
    decision: "allow",
    name: "reading a script is silent",
  },
  {
    command: "git commit -m 'mention rollback.sh'",
    decision: "allow",
    name: "describing a script is silent",
  },
  {
    category: "coolify-api-deploy",
    command: "curl -fsS https://coolify.example/api/v1/deploy",
    decision: "log",
    name: "Coolify deploy is logged",
  },
  {
    category: "coolify-api-lifecycle",
    command:
      "curl -fsS https://coolify.example/api/v1/applications/app-1/restart",
    decision: "log",
    name: "Coolify restart is logged",
  },
  {
    category: "coolify-api-write",
    command: "curl -X POST https://coolify.example/api/v1/applications",
    decision: "log",
    name: "Coolify POST is logged",
  },
  {
    command: "curl -fsS https://coolify.example/api/v1/applications",
    decision: "allow",
    name: "Coolify GET is silent",
  },
  {
    category: "github-production-dispatch",
    command: "gh workflow run deploy-production --ref main",
    decision: "log",
    name: "production workflow dispatch is logged",
  },
  {
    category: "github-production-dispatch",
    command: "gh run rerun 123 --workflow deploy-production.yml",
    decision: "log",
    name: "production workflow rerun is logged",
  },
  {
    command: "gh run view 123",
    decision: "allow",
    name: "GitHub run view is silent",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner docker restart app",
    decision: "log",
    name: "Hetzner docker restart is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner docker run image",
    decision: "log",
    name: "Hetzner docker run is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner docker exec app sh",
    decision: "log",
    name: "Hetzner docker exec is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner docker compose up -d",
    decision: "log",
    name: "Hetzner compose up is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner systemctl restart app",
    decision: "log",
    name: "Hetzner systemctl restart is logged",
  },
  {
    category: "hetzner-write",
    command: "scp file user@catapulze-hetzner:/tmp/file",
    decision: "log",
    name: "Hetzner scp is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner mkdir /srv/new",
    decision: "log",
    name: "Hetzner mkdir is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner 'echo x > /etc/app.conf'",
    decision: "log",
    name: "Hetzner redirection is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner docker rm -f ji-web",
    decision: "log",
    name: "non-database container removal is logged",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner rm /tmp/x.log",
    decision: "log",
    name: "plain Hetzner rm is logged",
  },
  {
    category: "sql-write",
    command: 'ssh catapulze-hetzner psql -c "INSERT INTO jobs VALUES (1)"',
    decision: "log",
    name: "non-destructive Hetzner SQL is logged",
  },
  {
    category: "sql-write",
    command: "ssh catapulze-hetzner psql -f migration.sql",
    decision: "log",
    name: "unverifiable Hetzner psql is logged",
  },
  {
    category: "sql-write",
    command:
      'ssh catapulze-hetzner psql -c "DROP INDEX CONCURRENTLY jobs_created_at_idx"',
    decision: "log",
    name: "DROP INDEX CONCURRENTLY is logged only",
  },
  {
    category: "sql-write",
    command: 'ssh catapulze-hetzner psql -c "UPDATE jobs SET x=1 WHERE id=5"',
    decision: "log",
    name: "UPDATE with WHERE is logged only",
  },
  {
    command: 'ssh catapulze-hetzner psql -c "SELECT count(*) FROM jobs"',
    decision: "allow",
    name: "Hetzner SELECT is silent",
  },
  {
    category: "sql-destructive",
    command: 'ssh catapulze-hetzner psql -c "SELECT 1; DELETE FROM jobs"',
    decision: "block",
    name: "mixed SQL blocks on DELETE",
  },
  {
    category: "sql-destructive",
    command: 'ssh catapulze-hetzner psql -c "DELETE FROM jobs"',
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved DELETE is allowed and logged",
  },
  {
    category: "sql-destructive",
    command: 'ssh catapulze-hetzner psql -c "TRUNCATE jobs"',
    decision: "block",
    name: "TRUNCATE blocks",
  },
  {
    category: "sql-destructive",
    command: 'ssh catapulze-hetzner psql -c "DROP TABLE jobs"',
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved DROP TABLE is allowed and logged",
  },
  {
    category: "sql-destructive",
    command: 'ssh catapulze-hetzner psql -c "DROP INDEX jobs_idx"',
    decision: "block",
    name: "DROP INDEX without CONCURRENTLY blocks",
  },
  {
    category: "sql-destructive",
    command: 'ssh catapulze-hetzner psql -c "UPDATE jobs SET x=1"',
    decision: "block",
    name: "UPDATE without WHERE blocks",
  },
  {
    category: "sql-destructive",
    command: 'ssh catapulze-hetzner psql -c "ALTER TABLE jobs DROP COLUMN x"',
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved ALTER DROP COLUMN is allowed and logged",
  },
  {
    category: "docker-volume-destroy",
    command: "ssh catapulze-hetzner docker volume rm ji_pg",
    decision: "block",
    name: "Docker volume removal blocks",
  },
  {
    category: "docker-volume-destroy",
    command: "ssh catapulze-hetzner docker system prune -a --volumes",
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved Docker volume prune is allowed and logged",
  },
  {
    category: "db-container-destroy",
    command: "ssh catapulze-hetzner docker rm -f ji-postgres",
    decision: "block",
    name: "database container removal blocks",
  },
  {
    category: "db-container-destroy",
    command: "ssh catapulze-hetzner docker container rm --force coolify-db",
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved database container removal is allowed and logged",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-hetzner rm -rf /srv/old",
    decision: "block",
    name: "recursive server removal blocks",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-prod /bin/rm -rf /srv/old",
    decision: "block",
    name: "path-qualified recursive server removal blocks",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-prod /usr/bin/rm -Rf /srv/old",
    decision: "block",
    name: "uppercase path-qualified recursive removal blocks",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-prod rm -Rf /srv/old",
    decision: "block",
    name: "uppercase recursive server removal blocks",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-prod rm -r -f /srv/old",
    decision: "block",
    name: "split recursive removal flags block",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-prod sudo rm -rf /srv/old",
    decision: "block",
    name: "sudo recursive server removal blocks",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-prod find /srv/old -delete",
    decision: "block",
    name: "find delete on production blocks",
  },
  {
    category: "server-rm-rf",
    command: String.raw`ssh catapulze-prod find /srv/old -exec rm -rf {} \;`,
    decision: "block",
    name: "find exec rm on production blocks",
  },
  {
    category: "server-rm-rf",
    command: "ssh catapulze-hetzner rm --recursive /srv/old",
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved recursive removal is allowed and logged",
  },
  {
    category: "approval-tamper",
    command:
      "sed -i s/2026-10-10/2026-10-11/ ~/.config/newones/release-approval",
    decision: "block",
    name: "sed in-place approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command:
      "perl -pi -e s/2026-10-10/2026-10-11/ ~/.config/newones/release-approval",
    decision: "block",
    name: "Perl in-place approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command:
      "perl -i -e s/2026-10-10/2026-10-11/ ~/.config/newones/release-approval",
    decision: "block",
    name: "Perl short in-place approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command: "awk -i inplace '{ print }' ~/.config/newones/release-approval",
    decision: "block",
    name: "Awk in-place approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command: "ed ~/.config/newones/release-approval",
    decision: "block",
    name: "ed approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command: "ex ~/.config/newones/release-approval",
    decision: "block",
    name: "ex approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command:
      "vim -c 's/2026-10-10/2026-10-11/' ~/.config/newones/release-approval",
    decision: "block",
    name: "Vim command approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command:
      'python -c \'open("~/.config/newones/release-approval", "w").write("x")\'',
    decision: "block",
    name: "Python approval tampering blocks",
  },
  {
    category: "approval-tamper",
    command: "sed -i s/host/a/ ~/.config/newones/production-gate.conf",
    decision: "block",
    name: "sed in-place production config tampering blocks",
    productionGateConfigContents: "host catapulze-prod\n",
  },
  {
    category: "pg-data-change",
    command: "ssh catapulze-hetzner rm -rf /var/lib/postgresql/data",
    decision: "block",
    name: "PostgreSQL data removal blocks",
  },
  {
    category: "pg-data-change",
    command: "scp dump catapulze-hetzner:/data/coolify/databases/pg",
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved PostgreSQL data change is allowed and logged",
  },
  {
    category: "pg-data-change",
    command: "ssh catapulze-prod mkdir -p /var/lib/postgresql/data/new",
    decision: "block",
    name: "PostgreSQL data mkdir blocks",
  },
  {
    category: "pg-data-change",
    command:
      "ssh catapulze-prod touch /var/lib/postgresql/data/postmaster.opts",
    decision: "block",
    name: "PostgreSQL data touch blocks",
  },
  {
    category: "pg-data-change",
    command:
      "ssh catapulze-prod install /tmp/pg.conf /data/coolify/databases/pg/pg.conf",
    decision: "block",
    name: "PostgreSQL data install blocks",
  },
  {
    category: "coolify-delete",
    command: "curl -X DELETE https://coolify.example/api/v1/applications/app-1",
    decision: "block",
    name: "Coolify DELETE blocks",
  },
  {
    category: "coolify-delete",
    command:
      'curl --request="DELETE" https://coolify.example/api/v1/applications/app-1',
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved quoted Coolify DELETE is allowed and logged",
  },
  {
    category: "gh-repo-delete",
    command: "gh repo delete acme/old-repo --yes",
    decision: "block",
    name: "GitHub repository delete blocks",
  },
  {
    category: "gh-repo-delete",
    command: "gh api --method DELETE repos/acme/old-repo",
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved GitHub repository API delete is allowed and logged",
  },
  {
    category: "force-push-main",
    command: "git push --force origin main",
    decision: "block",
    name: "force push main blocks",
  },
  {
    category: "force-push-main",
    command: "git -C /repo push --force origin main",
    decision: "block",
    name: "force push main with Git directory option blocks",
  },
  {
    category: "force-push-main",
    command: "git -c x=y push -f origin HEAD:main",
    decision: "block",
    name: "force push main with Git config option blocks",
  },
  {
    category: "force-push-main",
    command: "git --git-dir=.git push --force origin main",
    decision: "block",
    name: "force push main with Git directory flag blocks",
  },
  {
    category: "force-push-main",
    command: "git push --force-with-lease origin main",
    decision: "approved",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "approved force push main is allowed and logged",
  },
  {
    command: "git push --force-with-lease origin feat/x",
    decision: "allow",
    name: "force push feature branch is silent",
  },
  {
    command: "git push origin main",
    decision: "allow",
    name: "normal push main is silent",
  },
  {
    command: "git push --force-with-lease origin",
    decision: "allow",
    env: { PRODUCTION_GATE_CURRENT_BRANCH: "feat/x" },
    name: "force push without refspec on feature is silent",
  },
  {
    category: "force-push-main",
    command: "git push --force-with-lease origin",
    decision: "block",
    env: { PRODUCTION_GATE_CURRENT_BRANCH: "main" },
    name: "force push without refspec on main blocks",
  },
  {
    category: "force-push-main",
    command: "git push --force-with-lease origin",
    decision: "approved",
    env: {
      PRODUCTION_GATE_CURRENT_BRANCH: "main",
      RELEASE_APPROVAL: "PR-496",
    },
    name: "approved force push without refspec on main is logged",
  },
  {
    command: 'psql -h localhost -c "delete from jobs"',
    decision: "allow",
    name: "local psql DELETE is never blocked",
  },
  {
    command: 'psql postgres://ji:pw@localhost:5432/ji_test -c "truncate x"',
    decision: "allow",
    name: "localhost connection string SQL is never blocked",
  },
  {
    command: "ssh catapulze-hetzner docker ps",
    decision: "allow",
    name: "docker ps is silent",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-prod docker compose -f x.yml up -d",
    decision: "log",
    name: "production alias compose up is logged",
  },
  {
    category: "docker-volume-destroy",
    command: "docker --context catapulze-prod volume rm ji_pg",
    decision: "block",
    name: "Docker production context blocks volume removal",
  },
  {
    category: "docker-volume-destroy",
    command: "docker --context prod-alias volume rm ji_pg",
    decision: "block",
    name: "Docker configured context blocks volume removal",
    productionGateConfigContents: "host prod-alias\n",
  },
  {
    category: "docker-volume-destroy",
    command: "docker -H tcp://catapulze-prod:2376 volume rm ji_pg",
    decision: "block",
    name: "Docker TCP production host blocks volume removal",
  },
  {
    category: "server-rm-rf",
    command: "ssh -o HostName=catapulze-prod rm -rf /srv/old",
    decision: "block",
    name: "SSH HostName production option blocks recursive removal",
  },
  {
    category: "sql-destructive",
    command: 'PGHOST=catapulze-prod psql -c "DROP TABLE jobs"',
    decision: "block",
    name: "PGHOST production SQL blocks",
  },
  {
    category: "sql-destructive",
    command: 'psql -h catapulze-prod -c "DELETE FROM jobs"',
    decision: "block",
    name: "psql host production SQL blocks",
  },
  {
    category: "sql-destructive",
    command: 'psql postgres://ji:pw@catapulze-prod/jobs -c "TRUNCATE jobs"',
    decision: "block",
    name: "Postgres URL production SQL blocks",
  },
  {
    category: "hetzner-write",
    command: "ssh catapulze-hetzner 'printf y >> /srv/.env'",
    decision: "log",
    name: "production env append is logged",
  },
  {
    command: "ssh catapulze-prod docker logs --tail 50 ji-server | grep error",
    decision: "allow",
    name: "production container logs are silent",
  },
  {
    command:
      "ssh catapulze-prod 'docker exec ji-postgres psql -U ji -c \"select count(*) from curated.bron where actief\"'",
    decision: "allow",
    name: "production read-only database inspection is silent",
  },
  {
    command: "gh run view 1 --log",
    decision: "allow",
    name: "GitHub run log inspection is silent",
  },
  {
    command: "curl -fsS https://x/readyz",
    decision: "allow",
    name: "readiness probe is silent",
  },
  {
    category: "server-rm-rf",
    command: "ssh 100.64.0.9 'rm -rf /srv'",
    decision: "block",
    name: "configured production host blocks recursive removal",
    productionGateConfigContents: "host 100.64.0.9\n",
  },
  {
    command: "ssh 100.64.0.9 'rm -rf /srv'",
    decision: "allow",
    name: "unconfigured host is not a production target",
  },
  {
    category: "db-container-destroy",
    command: "ssh catapulze-prod docker rm -f abc123uuid",
    decision: "block",
    name: "configured database container name blocks removal",
    productionGateConfigContents: "db-container abc123uuid\n",
  },
  {
    category: "sql-destructive",
    command: "ssh catapulze-prod 'docker exec x psql -c \"drop table t\"'",
    decision: "block",
    name: "production alias destructive SQL blocks",
  },
  {
    category: "production-script",
    command: "cat ops/rollback.sh | bash",
    decision: "log",
    name: "piped ops rollback is logged",
  },
  {
    category: "production-script",
    command: "source ./release_apps.sh",
    decision: "log",
    name: "sourced release script is logged",
  },
  {
    category: "coolify-api-deploy",
    command: "curl -XPOST https://h/api/v1/deploy?uuid=x",
    decision: "log",
    name: "compact Coolify deploy POST is logged",
  },
  {
    category: "coolify-api-deploy",
    command:
      "curl -fsS https://x/api/v1/deploy -H 'Authorization: Basic basic-secret'",
    decision: "log",
    name: "logged basic authorization is redacted",
    secrets: ["basic-secret"],
  },
  {
    category: "coolify-api-deploy",
    command: "curl -fsS https://x/api/v1/deploy -H 'X-API-Key: api-key-secret'",
    decision: "log",
    name: "logged API key is redacted",
    secrets: ["api-key-secret"],
  },
  {
    category: "coolify-api-deploy",
    command:
      "curl -fsS https://x/api/v1/deploy -H 'Cookie: session-cookie-secret'",
    decision: "log",
    name: "logged cookie is redacted",
    secrets: ["session-cookie-secret"],
  },
  {
    category: "coolify-api-deploy",
    command: "curl -fsS https://user:url-secret@example/api/v1/deploy",
    decision: "log",
    name: "logged URL credentials are redacted",
    secrets: ["url-secret"],
  },
  {
    category: "coolify-api-deploy",
    command: "curl -fsS https://x/api/v1/deploy COOLIFY_API_TOKEN=token-secret",
    decision: "log",
    name: "logged token assignment is redacted",
    secrets: ["token-secret"],
  },
  {
    category: "coolify-api-deploy",
    command: "curl -fsS https://x/api/v1/deploy PGPASSWORD='x y'",
    decision: "log",
    name: "logged password assignment is redacted",
    secrets: ["x y"],
  },
  {
    category: "coolify-api-deploy",
    command: "curl -fsS https://x/api/v1/deploy --token='x'",
    decision: "log",
    name: "logged token option is redacted",
    secrets: ["--token='x'", "--token=x"],
  },
  {
    category: "coolify-api-deploy",
    command: "curl -fsS https://x/api/v1/deploy -H 'X-Token: x-token-secret'",
    decision: "log",
    name: "logged X token is redacted",
    secrets: ["x-token-secret"],
  },
  {
    category: "coolify-api-deploy",
    command:
      "curl -fsS https://x/api/v1/deploy -H 'X-Custom-Token: custom-token-secret'",
    decision: "log",
    name: "logged custom token header is redacted",
    secrets: ["custom-token-secret"],
  },
  {
    category: "coolify-api-deploy",
    command:
      'curl -fsS https://x/api/v1/deploy -H "X-Api-Token: api-token-secret"',
    decision: "log",
    name: "logged API token header is redacted",
    secrets: ["api-token-secret"],
  },
  {
    category: "coolify-api-deploy",
    command:
      'curl -fsS https://x/api/v1/deploy --data \'{"token":"json-token-secret","password":"json-password-secret","secret":"json-secret","apiKey":"json-api-key-secret"}\'',
    decision: "log",
    name: "logged JSON secrets are redacted",
    secrets: [
      "json-token-secret",
      "json-password-secret",
      "json-secret",
      "json-api-key-secret",
    ],
  },
  {
    category: "coolify-api-deploy",
    command:
      "curl -fsS https://x/api/v1/deploy --bearer-token bearer-secret --api-key api-key-secret --secret secret-option",
    decision: "log",
    name: "logged long secret options are redacted",
    secrets: ["bearer-secret", "api-key-secret", "secret-option"],
  },
  {
    category: "coolify-api-deploy",
    command: 'curl -fsS https://x/api/v1/deploy --password "x"',
    decision: "log",
    name: "logged password option is redacted",
    secrets: ['--password "x"', "--password x"],
  },
  {
    command: "Write production-gate.conf",
    decision: "block",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "Write production gate config cannot be overridden",
    productionGateConfigContents: "# existing\n",
    toolInput: { file_path: "__PRODUCTION_GATE_CONFIG__" },
    toolName: "Write",
  },
  {
    command: "Edit production-gate.conf",
    decision: "block",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "Edit production gate config cannot be overridden",
    productionGateConfigContents: "# existing\n",
    toolInput: { path: "__PRODUCTION_GATE_CONFIG__" },
    toolName: "Edit",
  },
  {
    command: "printf 'host 100.64.0.9\\n' > \"$PRODUCTION_GATE_CONFIG\"",
    decision: "block",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "Bash production gate config write cannot be overridden",
    productionGateConfigContents: "# existing\n",
  },
  {
    category: "coolify-api-deploy",
    command:
      "curl -fsS https://x/api/v1/deploy -H 'Authorization: Bearer super-secret'",
    decision: "log",
    name: "logged bearer secret is redacted",
    secrets: ["super-secret"],
  },
  {
    category: "coolify-api-deploy",
    command:
      "curl https://user:url-secret@example/api/v1/deploy COOLIFY_API_TOKEN=token-secret --password cli-password-secret",
    decision: "log",
    name: "logged URL and option secrets are redacted",
    secrets: ["url-secret", "token-secret", "cli-password-secret"],
  },
  {
    command: 'git commit -m "document git push --force origin main"',
    decision: "allow",
    name: "commit message force push text is silent",
  },
  {
    command: 'git commit -m "document gh repo delete acme/old"',
    decision: "allow",
    name: "commit message repository delete text is silent",
  },
  {
    command: 'git commit -m "doc: curl -X DELETE https://c/api/v1/x"',
    decision: "allow",
    name: "commit message API delete text is silent",
  },
  {
    command: 'git tag -m "document git push --force origin main" v1',
    decision: "allow",
    name: "tag message force push text is silent",
  },
  {
    command:
      'gh pr create --title "rm -rf on catapulze-prod" --body "gh repo delete acme/old"',
    decision: "allow",
    name: "pull request text is silent",
  },
  {
    command: 'gh pr comment 1 --body "rm -rf on catapulze-prod is blocked"',
    decision: "allow",
    name: "pull request comment text is silent",
  },
  {
    command: 'gh issue create --body "curl -X DELETE https://c/api/v1/x"',
    decision: "allow",
    name: "issue text is silent",
  },
  {
    command: 'echo "git push --force origin main"',
    decision: "allow",
    name: "echo destructive text is silent",
  },
  {
    command: 'printf "%s\\n" "rm -rf on catapulze-prod"',
    decision: "allow",
    name: "printf destructive text is silent",
  },
  {
    category: "force-push-main",
    command: 'git commit -m "$(git push --force origin main)"',
    decision: "block",
    name: "commit substitution force push blocks",
  },
  {
    category: "server-rm-rf",
    command: 'gh pr comment 1 --body "$(rm -rf /srv/old)"',
    decision: "block",
    name: "pull request substitution recursive removal blocks",
  },
  {
    category: "force-push-main",
    command:
      'git commit -m "document git push --force origin main"; git push --force origin main',
    decision: "block",
    name: "separate force push segment blocks",
  },
  {
    command: "",
    decision: "block",
    name: "Write approval file is tamper blocked",
    toolInput: { file_path: "~/.config/newones/release-approval" },
    toolName: "Write",
  },
  {
    command: "",
    decision: "block",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "Edit approval file cannot be overridden",
    toolInput: { path: "~/.config/newones/release-approval" },
    toolName: "Edit",
  },
  {
    command: "echo PR-496 2026-10-11 > release-approval",
    decision: "block",
    env: { RELEASE_APPROVAL: "PR-496" },
    name: "Bash approval file write cannot be overridden",
  },
  {
    category: "production-script",
    command: ["bash", "./rollback.sh"],
    decision: "log",
    name: "Codex array command is logged",
    toolName: "shell",
  },
  {
    command: "./rollback.sh",
    decision: "allow",
    name: "non-command tool is ignored",
    toolName: "Read",
  },
  {
    command: "gh run view 123",
    decision: "allow",
    name: "exec_command tool name is accepted",
    toolName: "exec_command",
  },
  {
    command: "",
    decision: "allow",
    name: "invalid JSON without a marker is fail-open",
    stdin: '{"tool_name":"Bash"',
  },
  {
    category: "input-parse-error",
    command: "",
    decision: "log",
    name: "invalid JSON with non-destructive marker is logged",
    stdin:
      '{"tool_name":"Bash","tool_input":{"command":"gh workflow run deploy-production"',
  },
  {
    command: "",
    decision: "block",
    name: "invalid JSON with destructive marker blocks",
    stdin:
      '{"tool_name":"Bash","tool_input":{"command":"ssh catapulze-hetzner psql -c \\"delete from jobs"',
  },
  {
    command: "",
    decision: "allow",
    name: "empty stdin is silent",
    stdin: "",
  },
  {
    command: "",
    decision: "allow",
    name: "Write ordinary file is allowed",
    toolInput: { file_path: "src/x.ts" },
    toolName: "Write",
  },
];

describe.each(cases)("$name", (testCase) => {
  it(`returns ${testCase.decision}`, () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), "production-gate-hook-"));
    try {
      const logPath = path.join(tempHome, "state", "production-gate.log");
      const approvalPath = path.join(tempHome, "config", "release-approval");
      const productionGateConfigPath = path.join(
        tempHome,
        "config",
        "production-gate.conf"
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: tempHome,
        PRODUCTION_GATE_LOG: logPath,
        PRODUCTION_GATE_TODAY: today,
        XDG_CONFIG_HOME: path.join(tempHome, "config"),
        XDG_STATE_HOME: path.join(tempHome, "state"),
      };
      delete env.RELEASE_APPROVAL;
      delete env.RELEASE_APPROVAL_FILE;
      delete env.PRODUCTION_GATE_CURRENT_BRANCH;
      Object.assign(env, testCase.env);
      const toolInput = Object.fromEntries(
        Object.entries(testCase.toolInput ?? {}).map(([key, value]) => [
          key,
          value === "__PRODUCTION_GATE_CONFIG__"
            ? productionGateConfigPath
            : value,
        ])
      );
      if (testCase.productionGateConfigContents === undefined) {
        delete env.PRODUCTION_GATE_CONFIG;
      } else {
        mkdirSync(path.dirname(productionGateConfigPath), { recursive: true });
        writeFileSync(
          productionGateConfigPath,
          testCase.productionGateConfigContents
        );
        env.PRODUCTION_GATE_CONFIG = productionGateConfigPath;
      }
      if (testCase.fileContents !== undefined) {
        mkdirSync(path.dirname(approvalPath), { recursive: true });
        writeFileSync(approvalPath, testCase.fileContents);
        env.RELEASE_APPROVAL_FILE = approvalPath;
      }

      const input =
        testCase.stdin ??
        JSON.stringify({
          tool_input: { command: testCase.command, ...toolInput },
          tool_name: testCase.toolName ?? "Bash",
        });
      const result = spawnSync("bash", [hookPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env,
        input,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(testCase.decision === "block" ? 2 : 0);
      expect(result.stdout).toBe("");
      if (testCase.decision === "block") {
        expect(result.stderr).toContain("BLOCKED by production-gate");
      }
      if (testCase.decision === "log" || testCase.decision === "approved") {
        expect(existsSync(logPath)).toBe(true);
        const log = readFileSync(logPath, "utf-8");
        const decision =
          testCase.decision === "approved" ? "ALLOWED" : "LOGGED";
        expect(log).toContain(`\t${decision}\t${testCase.category}\t`);
      }
      if (testCase.decision === "allow") {
        expect(existsSync(logPath)).toBe(false);
      }
      if (testCase.secrets) {
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("REDACTED");
        for (const secret of testCase.secrets) {
          expect(log).not.toContain(secret);
        }
      }
    } finally {
      rmSync(tempHome, { force: true, recursive: true });
    }
  });
});
