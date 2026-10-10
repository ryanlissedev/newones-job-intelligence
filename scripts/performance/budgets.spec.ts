import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

interface ProductBudget {
  label: string;
  path: string;
  window: string;
  metrics: {
    absoluteThreshold: number;
    comparison: string;
    name: string;
    statistic: string;
    unit: string;
  }[];
  fixture: { bronnen: number; days: number; runs: number };
  postgresRoundTripsMax: number;
  externalHttpInRequestPath: number;
  enforcement: string;
  source: string[];
}

interface PerformanceBudgets {
  deliveryPhases: string[];
  measurementContract: { absoluteThreshold: number | null };
  productBudgets: ProductBudget[];
}

const budgetsPath = path.join(import.meta.dir, "performance-budgets.json");

const readBudgets = async (): Promise<PerformanceBudgets> =>
  // SAFETY: this test validates the required contract fields immediately after parsing.
  JSON.parse(await readFile(budgetsPath, "utf-8")) as PerformanceBudgets;

const validateProductBudget: (
  candidate: Partial<ProductBudget>
) => asserts candidate is ProductBudget = (candidate) => {
  const requiredFields: (keyof ProductBudget)[] = [
    "label",
    "path",
    "window",
    "metrics",
    "fixture",
    "postgresRoundTripsMax",
    "externalHttpInRequestPath",
    "enforcement",
    "source",
  ];
  for (const field of requiredFields) {
    if (!(field in candidate)) {
      throw new Error(`product budget is missing ${field}`);
    }
  }
};

test("keeps delivery observe-only and declares the accepted bron dashboard budget", async () => {
  const budgets = await readBudgets();
  const productBudget = budgets.productBudgets.find(
    ({ label }) => label === "bron-dashboard"
  );

  expect(budgets.measurementContract.absoluteThreshold).toBeNull();
  expect(productBudget).toBeDefined();
  validateProductBudget(productBudget ?? {});
  expect(productBudget).toMatchObject({
    enforcement: "measure-warn-ready",
    externalHttpInRequestPath: 0,
    fixture: { bronnen: 12, days: 60, runs: 50_000 },
    label: "bron-dashboard",
    path: "get_dashboard_overview",
    postgresRoundTripsMax: 4,
    source: ["ADR-0003", "docs/evidence/rjc-415", "PR #182"],
    window: "30d",
  });
  expect(productBudget?.metrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        absoluteThreshold: 1000,
        name: "get_dashboard_overview",
        statistic: "p95",
      }),
      expect.objectContaining({
        absoluteThreshold: 300,
        name: "bronRunStats",
        scope: "each-query",
        statistic: "p95",
      }),
      expect.objectContaining({
        absoluteThreshold: 300,
        name: "bronRunTimeseries",
        scope: "each-query",
        statistic: "p95",
      }),
    ])
  );
});

test("rejects a product budget missing required contract fields", async () => {
  const budgets = await readBudgets();
  const [productBudget] = budgets.productBudgets;
  if (!productBudget) {
    throw new Error("expected at least one product budget");
  }
  const requiredFields = [
    "label",
    "path",
    "window",
    "metrics",
    "fixture",
    "postgresRoundTripsMax",
    "externalHttpInRequestPath",
    "enforcement",
    "source",
  ] as const;

  for (const field of requiredFields) {
    const { [field]: omitted, ...candidate } = productBudget;
    void omitted;
    expect(() => validateProductBudget(candidate)).toThrow(
      `product budget is missing ${field}`
    );
  }
});
