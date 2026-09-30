#!/usr/bin/env node
/**
 * Apply (or dump) the Job Intelligence Linear catalog.
 *
 *   LINEAR_API_KEY=lin_api_... node docs/linear/apply.mjs
 *   node docs/linear/apply.mjs --dump-json --dump-csv
 *   LINEAR_API_KEY=... node docs/linear/apply.mjs --dry-run
 *
 * Env:
 *   LINEAR_API_KEY or LINEAR_API_TOKEN  required for apply
 *   LINEAR_TEAM_ID / LINEAR_TEAM_KEY / LINEAR_TEAM_NAME  optional overrides
 *   LINEAR_ASSIGN_IF_RYAN=1  assign to viewer only if email matches LINEAR_OWNER_EMAIL
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog, issuesInCreateOrder } from "./issues.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = "https://api.linear.app/graphql";
const RYAN_EMAIL = process.env.LINEAR_OWNER_EMAIL ?? "";
const CATALOG_MARKER_PREFIX = "catapulze-linear-catalog-id";

const args = new Set(process.argv.slice(2));
const dumpJson = args.has("--dump-json");
const dumpCsv = args.has("--dump-csv");
const dryRun = args.has("--dry-run");
const apply = !dumpJson && !dumpCsv ? true : args.has("--apply");

const apiKey = process.env.LINEAR_API_KEY || process.env.LINEAR_API_TOKEN || "";

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function priorityLabel(priority) {
  switch (priority) {
    case 1:
      return "Urgent";
    case 2:
      return "High";
    case 3:
      return "Medium";
    case 4:
      return "Low";
    default:
      return "No priority";
  }
}

function csvStatus(issue) {
  return issue.status === "TodoIfCycle" ? "Todo" : issue.status;
}

function dumpFiles() {
  const jsonPath = join(HERE, "job-intelligence-import.json");
  const csvPath = join(HERE, "job-intelligence-import.csv");

  const payload = {
    meta: catalog.meta,
    team: catalog.team,
    project: catalog.project,
    milestones: catalog.milestones,
    labels: catalog.labels,
    issues: catalog.issues.map((issue) => ({
      id: issue.id,
      title: issue.title,
      kind: issue.kind,
      milestone: issue.milestone,
      labels: issue.labels,
      status: csvStatus(issue),
      statusRule: issue.status,
      priority: issue.priority,
      priorityLabel: priorityLabel(issue.priority),
      parent: issue.parent,
      blockedBy: issue.blockedBy,
      description: issue.description,
    })),
  };
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.error(`Wrote ${jsonPath}`);

  const header = [
    "Title",
    "Description",
    "Status",
    "Priority",
    "Labels",
    "Project",
    "Milestone",
    "Parent",
    "BlockedBy",
    "Kind",
    "CatalogId",
  ];
  const rows = catalog.issues.map((issue) =>
    [
      issue.title,
      issue.description,
      csvStatus(issue),
      priorityLabel(issue.priority),
      issue.labels.join(", "),
      catalog.project.name,
      catalog.milestones.find((m) => m.key === issue.milestone)?.name ?? issue.milestone,
      issue.parent ?? "",
      issue.blockedBy.join(", "),
      issue.kind,
      issue.id,
    ]
      .map(csvEscape)
      .join(","),
  );
  writeFileSync(csvPath, `${header.join(",")}\n${rows.join("\n")}\n`);
  console.error(`Wrote ${csvPath}`);
}

async function gql(query, variables) {
  const response = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    const message = body.errors?.map((e) => e.message).join("; ") || response.statusText;
    throw new Error(`Linear GraphQL error: ${message}`);
  }
  return body.data;
}

function pickTeam(teams) {
  const id = process.env.LINEAR_TEAM_ID;
  if (id) {
    const match = teams.find((t) => t.id === id);
    if (!match) throw new Error(`LINEAR_TEAM_ID ${id} not found`);
    return match;
  }
  const key = process.env.LINEAR_TEAM_KEY?.toUpperCase();
  if (key) {
    const match = teams.find((t) => t.key?.toUpperCase() === key);
    if (!match) throw new Error(`LINEAR_TEAM_KEY ${key} not found`);
    return match;
  }
  const name = process.env.LINEAR_TEAM_NAME;
  if (name) {
    const match = teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!match) throw new Error(`LINEAR_TEAM_NAME ${name} not found`);
    return match;
  }
  for (const preferred of catalog.team.preferredNames) {
    const exact = teams.find((t) => t.name.toLowerCase() === preferred.toLowerCase());
    if (exact) return exact;
  }
  for (const preferred of catalog.team.preferredNames) {
    const partial = teams.find((t) => t.name.toLowerCase().includes(preferred.toLowerCase()));
    if (partial) return partial;
  }
  for (const preferredKey of catalog.team.preferredKeys) {
    const match = teams.find((t) => t.key?.toUpperCase() === preferredKey);
    if (match) return match;
  }
  if (teams.length === 0) throw new Error("No Linear teams visible to this API key");
  return teams[0];
}

function findState(states, { want, type }) {
  const byName = states.find((s) => s.name.toLowerCase() === want.toLowerCase());
  if (byName) return byName;
  return states.find((s) => s.type === type) ?? null;
}

async function ensureProject(team) {
  const existing = await gql(
    `query($eq: String!) {
      projects(filter: { name: { eqIgnoreCase: $eq } }) {
        nodes { id name url }
      }
    }`,
    { eq: catalog.project.name },
  );
  const found = existing.projects.nodes[0];
  if (found) {
    console.error(`Project exists: ${found.url}`);
    return found;
  }
  if (dryRun) {
    console.error(`[dry-run] would create project ${catalog.project.name}`);
    return { id: "dry-project", name: catalog.project.name, url: "(dry-run)" };
  }
  const created = await gql(
    `mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        success
        project { id name url }
      }
    }`,
    {
      input: {
        name: catalog.project.name,
        teamIds: [team.id],
        description: catalog.project.description,
      },
    },
  );
  if (!created.projectCreate.success) throw new Error("projectCreate failed");
  console.error(`Created project: ${created.projectCreate.project.url}`);
  return created.projectCreate.project;
}

async function ensureMilestones(project) {
  if (dryRun && project.id === "dry-project") {
    return Object.fromEntries(
      catalog.milestones.map((milestone) => [
        milestone.key,
        { id: `dry-ms-${milestone.key}`, name: milestone.name },
      ]),
    );
  }
  const data = await gql(
    `query($id: String!) {
      project(id: $id) {
        projectMilestones { nodes { id name } }
      }
    }`,
    { id: project.id },
  );
  const existing = new Map((data.project?.projectMilestones?.nodes ?? []).map((m) => [m.name, m]));
  const map = {};
  for (const milestone of catalog.milestones) {
    const found = existing.get(milestone.name);
    if (found) {
      map[milestone.key] = found;
      continue;
    }
    if (dryRun) {
      map[milestone.key] = { id: `dry-ms-${milestone.key}`, name: milestone.name };
      continue;
    }
    const created = await gql(
      `mutation($input: ProjectMilestoneCreateInput!) {
        projectMilestoneCreate(input: $input) {
          success
          projectMilestone { id name }
        }
      }`,
      {
        input: {
          projectId: project.id,
          name: milestone.name,
          description: milestone.description,
        },
      },
    );
    if (!created.projectMilestoneCreate.success) {
      throw new Error(`projectMilestoneCreate failed for ${milestone.name}`);
    }
    map[milestone.key] = created.projectMilestoneCreate.projectMilestone;
  }
  return map;
}

async function ensureLabels(team) {
  const data = await gql(
    `query($id: String!) {
      team(id: $id) {
        labels { nodes { id name } }
      }
    }`,
    { id: team.id },
  );
  const existing = new Map((data.team.labels?.nodes ?? []).map((l) => [l.name.toLowerCase(), l]));
  const map = {};
  for (const label of catalog.labels) {
    const found = existing.get(label.name.toLowerCase());
    if (found) {
      map[label.name] = found;
      continue;
    }
    if (dryRun) {
      map[label.name] = { id: `dry-label-${label.name}`, name: label.name };
      continue;
    }
    const created = await gql(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }`,
      {
        input: {
          teamId: team.id,
          name: label.name,
          color: label.color,
          description: label.description,
        },
      },
    );
    if (!created.issueLabelCreate.success) {
      throw new Error(`issueLabelCreate failed for ${label.name}`);
    }
    map[label.name] = created.issueLabelCreate.issueLabel;
  }
  return map;
}

async function existingProjectIssues(project) {
  const nodes = [];
  let after = null;
  for (;;) {
    const data = await gql(
      `query($id: String!, $after: String) {
        project(id: $id) {
          issues(first: 100, after: $after) {
            nodes { id identifier url title description }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: project.id, after },
    );
    const conn = data.project.issues;
    nodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return nodes;
}

export function catalogMarker(catalogId) {
  return `<!-- ${CATALOG_MARKER_PREFIX}: ${catalogId} -->`;
}

export function descriptionWithCatalogMarker(issue) {
  const marker = catalogMarker(issue.id);
  return issue.description.includes(marker)
    ? issue.description
    : `${issue.description.trimEnd()}\n\n${marker}`;
}

function titleCatalogId(title) {
  const match = /^\[([^\]]+)\](?:\s|$)/u.exec(title);
  return match?.[1] ?? null;
}

function uniqueMatch(issue, strategy, candidates) {
  if (candidates.length > 1) {
    const identifiers = candidates
      .map((candidate) => candidate.identifier ?? candidate.id)
      .join(", ");
    throw new Error(`Ambiguous Linear match for ${issue.id} via ${strategy}: ${identifiers}`);
  }
  return candidates[0] ?? null;
}

export function findExistingIssue(issue, existingIssues) {
  const strategies = [];
  if (issue.linearId) {
    strategies.push([
      "linearId",
      existingIssues.filter((candidate) => candidate.id === issue.linearId),
    ]);
  }
  if (issue.linearIdentifier) {
    strategies.push([
      "linearIdentifier",
      existingIssues.filter(
        (candidate) => candidate.identifier?.toLowerCase() === issue.linearIdentifier.toLowerCase(),
      ),
    ]);
  }
  const marker = catalogMarker(issue.id);
  strategies.push(
    [
      "description marker",
      existingIssues.filter((candidate) => candidate.description?.includes(marker)),
    ],
    [
      "title catalog id",
      existingIssues.filter(
        (candidate) => titleCatalogId(candidate.title)?.toLowerCase() === issue.id.toLowerCase(),
      ),
    ],
    ["exact title", existingIssues.filter((candidate) => candidate.title === issue.title)],
  );

  let match = null;
  for (const [strategy, candidates] of strategies) {
    const candidate = uniqueMatch(issue, strategy, candidates);
    if (!candidate) continue;
    if (match && match.id !== candidate.id) {
      throw new Error(
        `Conflicting Linear identity signals for ${issue.id}: ${match.identifier ?? match.id} and ${candidate.identifier ?? candidate.id}`,
      );
    }
    match = candidate;
  }
  return match;
}

export function resolveStateId(issue, states, hasCycle) {
  const todo = findState(states, { want: "Todo", type: "unstarted" });
  const backlog = findState(states, { want: "Backlog", type: "backlog" }) ?? todo;
  const done = findState(states, { want: "Done", type: "completed" });
  if (issue.status === "TodoIfCycle") {
    return hasCycle ? todo?.id : backlog?.id;
  }
  if (issue.status === "Todo") return todo?.id;
  if (issue.status === "Done") return done?.id;
  return backlog?.id;
}

export function buildExistingIssueUpdate(issue, states, activeCycle) {
  const hasCycle = Boolean(activeCycle?.id);
  const stateId = resolveStateId(issue, states, hasCycle);
  if (!stateId) {
    throw new Error(
      `No Linear workflow state resolves catalog status ${issue.status} for ${issue.id}`,
    );
  }
  const input = {
    title: issue.title,
    description: descriptionWithCatalogMarker(issue),
    stateId,
  };
  if (issue.status === "TodoIfCycle") {
    input.cycleId = activeCycle?.id ?? null;
  }
  return input;
}

async function applyToLinear() {
  if (!apiKey) {
    console.error(
      "LINEAR_API_KEY / LINEAR_API_TOKEN is not set. Dumping CSV/JSON instead. See docs/linear/README.md.",
    );
    args.add("--dump-json");
    args.add("--dump-csv");
    dumpFiles();
    process.exitCode = 2;
    return;
  }

  const boot = await gql(`{
    viewer { id name email }
    teams { nodes { id name key } }
  }`);
  const team = pickTeam(boot.teams.nodes);
  console.error(`Viewer: ${boot.viewer.name} <${boot.viewer.email}>`);
  console.error(`Team: ${team.name} (${team.key})`);

  const teamDetail = await gql(
    `query($id: String!) {
      team(id: $id) {
        states { nodes { id name type } }
        activeCycle { id number }
      }
    }`,
    { id: team.id },
  );
  const states = teamDetail.team.states.nodes;
  const activeCycle = teamDetail.team.activeCycle;
  const hasCycle = Boolean(activeCycle?.id);
  console.error(
    hasCycle ? `Active cycle: ${activeCycle.number}` : "No active cycle; U1–U3 go to Backlog",
  );

  const assign =
    process.env.LINEAR_ASSIGN_IF_RYAN === "1" && boot.viewer.email?.toLowerCase() === RYAN_EMAIL
      ? boot.viewer.id
      : null;
  if (boot.viewer.email?.toLowerCase() === RYAN_EMAIL && assign) {
    console.error(`Assigning created issues to ${boot.viewer.email}`);
  }

  const project = await ensureProject(team);
  const milestones = await ensureMilestones(project);
  const labels = await ensureLabels(team);
  const existing =
    dryRun && project.id === "dry-project" ? [] : await existingProjectIssues(project);
  const created = new Map();

  for (const issue of issuesInCreateOrder()) {
    const already = findExistingIssue(issue, existing);
    if (already) {
      const input = buildExistingIssueUpdate(issue, states, activeCycle);
      if (dryRun) {
        created.set(issue.id, { ...already, ...input });
        console.error(`[dry-run] would update ${already.identifier}: ${issue.title}`);
        continue;
      }
      const result = await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { id identifier url title }
          }
        }`,
        { id: already.id, input },
      );
      if (!result.issueUpdate.success) {
        throw new Error(`issueUpdate failed: ${issue.title}`);
      }
      created.set(issue.id, result.issueUpdate.issue);
      console.error(`Updated ${already.identifier}: ${issue.title}`);
      continue;
    }
    const parent = issue.parent ? created.get(issue.parent) : null;
    const labelIds = issue.labels.map((name) => labels[name]?.id).filter(Boolean);
    const stateId = resolveStateId(issue, states, hasCycle);
    if (!stateId) {
      throw new Error(
        `No Linear workflow state resolves catalog status ${issue.status} for ${issue.id}`,
      );
    }
    const input = {
      teamId: team.id,
      title: issue.title,
      description: descriptionWithCatalogMarker(issue),
      projectId: project.id,
      projectMilestoneId: milestones[issue.milestone]?.id,
      parentId: parent?.id,
      labelIds,
      priority: issue.priority,
      stateId,
      cycleId: issue.status === "TodoIfCycle" && hasCycle ? activeCycle.id : undefined,
      assigneeId: assign,
    };
    if (dryRun) {
      created.set(issue.id, {
        id: `dry-${issue.id}`,
        identifier: issue.id,
        url: "(dry-run)",
        title: issue.title,
      });
      console.error(`[dry-run] would create ${issue.title}`);
      continue;
    }
    const result = await gql(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url title }
        }
      }`,
      { input },
    );
    if (!result.issueCreate.success) throw new Error(`issueCreate failed: ${issue.title}`);
    created.set(issue.id, result.issueCreate.issue);
    console.error(`Created ${result.issueCreate.issue.identifier}: ${issue.title}`);
    console.error(`  ${result.issueCreate.issue.url}`);
  }

  for (const issue of catalog.issues) {
    const source = created.get(issue.id);
    if (!source || dryRun) continue;
    for (const blockerId of issue.blockedBy) {
      const blocker = created.get(blockerId);
      if (!blocker) {
        console.error(`Skip relation: missing ${blockerId} for ${issue.id}`);
        continue;
      }
      try {
        await gql(
          `mutation($input: IssueRelationCreateInput!) {
            issueRelationCreate(input: $input) {
              success
            }
          }`,
          {
            input: {
              issueId: blocker.id,
              relatedIssueId: source.id,
              type: "blocks",
            },
          },
        );
        console.error(`Relation: ${blocker.identifier} blocks ${source.identifier}`);
      } catch (error) {
        const message = String(error.message);
        if (/already exists|duplicate/i.test(message)) {
          console.error(`Relation already present: ${blocker.identifier} → ${source.identifier}`);
          continue;
        }
        throw error;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        project: { name: project.name, url: project.url, id: project.id },
        team: { name: team.name, key: team.key, id: team.id },
        issues: catalog.issues.map((issue) => {
          const node = created.get(issue.id);
          return {
            catalogId: issue.id,
            title: issue.title,
            kind: issue.kind,
            identifier: node?.identifier ?? null,
            url: node?.url ?? null,
          };
        }),
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  if (dumpJson || dumpCsv) {
    dumpFiles();
  }

  if (apply || dryRun) {
    applyToLinear().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
