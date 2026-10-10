import { describe, expect, it } from "bun:test";

import { collectLayeringViolations } from "./check-layering";

describe("check-layering", () => {
  it("allows web files that only import UI and API types", () => {
    const source = `import { trpc } from "@/utils/trpc";
import { Button } from "@ji/ui/components/button";
`;
    expect(
      collectLayeringViolations("apps/web/src/app/page.tsx", source)
    ).toEqual([]);
  });

  it("fails a web file that imports @ji/db", () => {
    const source = `import { db } from "@ji/db";
`;
    expect(collectLayeringViolations("apps/web/src/leak.ts", source)).toContain(
      "apps/web/src/leak.ts imports forbidden module @ji/db"
    );
  });

  it("fails a web file that imports drizzle-orm", () => {
    const source = `import { eq } from "drizzle-orm";
`;
    expect(collectLayeringViolations("apps/web/src/leak.ts", source)).toContain(
      "apps/web/src/leak.ts imports forbidden module drizzle-orm"
    );
  });

  it("fails a web file that imports the source registry or identity layer", () => {
    for (const specifier of [
      "@ji/application/sources",
      "@ji/application/identity",
    ]) {
      const source = `import { SOURCES } from "${specifier}";
`;
      expect(
        collectLayeringViolations("apps/web/src/leak.ts", source)
      ).toContain(`apps/web/src/leak.ts imports forbidden module ${specifier}`);
    }
  });

  it("fails a web file that reaches packages/infra", () => {
    const source = `import { pool } from "../../../packages/infra/src/db";
`;
    expect(
      collectLayeringViolations("apps/web/src/leak.ts", source).length
    ).toBeGreaterThan(0);
  });
});
