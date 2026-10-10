import { describe, expect, it } from "bun:test";

interface TurboTaskDefinition {
  readonly env?: readonly string[];
}

interface TurboConfiguration {
  readonly tasks?: Readonly<Record<string, TurboTaskDefinition>>;
}

const turboConfiguration: TurboConfiguration = await Bun.file(
  new URL("../turbo.json", import.meta.url)
).json();

const taskEnv = (taskName: string): readonly string[] => {
  const task = turboConfiguration.tasks?.[taskName];
  if (!task) {
    throw new Error(`turbo.json is missing task ${taskName}`);
  }
  return task.env ?? [];
};

describe("Turbo production database env contracts", () => {
  it("passes the direct advisory-lock URL to the projector task", () => {
    expect(taskEnv("projector")).toContain("PROJECTOR_DATABASE_URL");
  });

  it("passes the explicit hybrid-search opt-in to the projector task", () => {
    expect(taskEnv("projector")).toContain("SEARCH_HYBRID");
  });

  it.each(["db:generate", "db:migrate", "db:push", "db:studio"])(
    "passes only the explicit migration URL to %s",
    (taskName) => {
      expect(taskEnv(taskName)).toEqual(["MIGRATION_DATABASE_URL"]);
    }
  );
});
