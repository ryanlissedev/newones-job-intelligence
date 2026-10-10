"use client";

import type { ReactNode } from "react";

import {
  BronSparkline,
  BronTrendChart,
  SparklineWidthProvider,
} from "@/components/dashboard/charts";
import type {
  BronSparkPoint,
  BronTrendPoint,
} from "@/components/dashboard/charts";

export const BronnenTrendPanel = ({
  data,
}: {
  readonly data: readonly BronTrendPoint[];
}) => (
  <section aria-labelledby="bronnen-trend-heading" className="space-y-3">
    <div>
      <h2
        className="font-display text-xl font-semibold"
        id="bronnen-trend-heading"
      >
        Trend
      </h2>
      <p className="text-sm text-muted-foreground">
        Nieuw, gewijzigd en rejected gestapeld per dag; failed als lijn.
      </p>
    </div>
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <BronTrendChart data={data} />
    </div>
  </section>
);

export const BronnenSparklineHost = ({
  children,
}: {
  readonly children: ReactNode;
}) => <SparklineWidthProvider>{children}</SparklineWidthProvider>;

export const BronnenCardSparkline = ({
  data,
  bronName,
}: {
  readonly data: readonly BronSparkPoint[];
  readonly bronName: string;
}) => (
  <div className="space-y-1 border-t border-border pt-3">
    <p className="text-[11px] text-muted-foreground">Sparkline · nieuw</p>
    <BronSparkline data={data} label={`Sparkline ${bronName}`} />
  </div>
);
