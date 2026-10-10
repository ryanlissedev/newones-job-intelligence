import { describe, expect, test } from "bun:test";
import {
  buildExistingIssueUpdate,
  catalogMarker,
  findExistingIssue,
  resolveStateId,
} from "./apply.mjs";
import { catalog } from "./issues.mjs";

const states = [
  { id: "backlog-id", name: "Backlog", type: "backlog" },
  { id: "todo-id", name: "Todo", type: "unstarted" },
  { id: "completed-id", name: "Complete", type: "completed" },
];

describe("resolveStateId", () => {
  test("maps catalog Done to the team's completed state", () => {
    expect(resolveStateId({ status: "Done" }, states, false)).toBe("completed-id");
  });

  test("prefers a state explicitly named Done", () => {
    const statesWithDone = [...states, { id: "done-id", name: "Done", type: "completed" }];

    expect(resolveStateId({ status: "Done" }, statesWithDone, false)).toBe("done-id");
  });
});

describe("stable issue reconciliation", () => {
  test("updates renamed DEC-005 on the same known Linear issue to Done", () => {
    const issue = catalog.issues.find(({ id }) => id === "DEC-005");
    if (!issue) throw new Error("DEC-005 fixture is missing from the catalog");
    const existing = {
      id: "linear-opaque-321",
      identifier: "RJC-321",
      url: "https://linear.app/example/issue/RJC-321/old-title",
      title: "[DEC-005] Kies nieuwe of bestaande Neon-database",
      description: "Old decision text",
    };

    const match = findExistingIssue(issue, [existing]);
    const update = buildExistingIssueUpdate(issue, states, null);

    expect(match?.id).toBe(existing.id);
    expect(update).toEqual({
      title:
        "[DEC-005] Gebruik Postgres 16 on-box; Motian-Neon alleen als read-only importbron",
      description: `${issue.description}\n\n${catalogMarker("DEC-005")}`,
      stateId: "completed-id",
    });
    expect(Object.keys(update).sort()).toEqual(["description", "stateId", "title"]);
  });

  test("moves an existing TodoIfCycle issue into the active cycle", () => {
    const issue = catalog.issues.find(({ id }) => id === "U1");
    if (!issue) throw new Error("U1 fixture is missing from the catalog");

    const update = buildExistingIssueUpdate(issue, states, {
      id: "active-cycle-id",
      number: 7,
    });

    expect(update).toMatchObject({
      title: issue.title,
      stateId: "todo-id",
      cycleId: "active-cycle-id",
    });
    expect(update.description).toContain(catalogMarker("U1"));
  });

  test("clears cycle membership for TodoIfCycle when no cycle is active", () => {
    const issue = catalog.issues.find(({ id }) => id === "U1");
    if (!issue) throw new Error("U1 fixture is missing from the catalog");

    expect(buildExistingIssueUpdate(issue, states, null)).toMatchObject({
      stateId: "backlog-id",
      cycleId: null,
    });
  });

  test("leaves cycle membership unchanged for statuses that do not own it", () => {
    const issue = {
      id: "REGULAR-TODO",
      title: "Regular todo",
      description: "Keep its current cycle",
      status: "Todo",
    };
    const update = buildExistingIssueUpdate(issue, states, { id: "active-cycle-id", number: 7 });

    expect(update.stateId).toBe("todo-id");
    expect(update).not.toHaveProperty("cycleId");
  });

  test("uses the durable catalog marker after a title changes", () => {
    const issue = {
      id: "U1",
      title: "New title",
      description: "New description",
      status: "Backlog",
    };
    const existing = {
      id: "linear-u1",
      identifier: "RJC-400",
      title: "Completely renamed",
      description: `Previous text\n\n${catalogMarker("U1")}`,
    };

    expect(findExistingIssue(issue, [existing])?.id).toBe("linear-u1");
  });

  test("fails closed when a catalog identity is ambiguous", () => {
    const issue = {
      id: "DEC-005",
      linearIdentifier: "RJC-321",
      title: "[DEC-005] New title",
      description: "Decision",
      status: "Done",
    };
    const duplicates = [
      {
        id: "first",
        identifier: "RJC-321",
        title: "First",
        description: "",
      },
      {
        id: "second",
        identifier: "RJC-321",
        title: "Second",
        description: "",
      },
    ];

    expect(() => findExistingIssue(issue, duplicates)).toThrow(
      "Ambiguous Linear match for DEC-005 via linearIdentifier",
    );
  });

  test("fails closed when identity signals point to different issues", () => {
    const issue = {
      id: "DEC-005",
      linearIdentifier: "RJC-321",
      title: "[DEC-005] New title",
      description: "Decision",
      status: "Done",
    };
    const conflicts = [
      {
        id: "known-identifier",
        identifier: "RJC-321",
        title: "Unrelated old title",
        description: "",
      },
      {
        id: "catalog-title",
        identifier: "RJC-999",
        title: "[DEC-005] New title",
        description: "",
      },
    ];

    expect(() => findExistingIssue(issue, conflicts)).toThrow(
      "Conflicting Linear identity signals for DEC-005",
    );
  });
});
