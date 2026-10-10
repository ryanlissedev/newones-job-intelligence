"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/**
 * `typedRoutes` types router.push against the literal route union, which a
 * URL assembled at runtime can never satisfy. Naming the parameter type here
 * keeps the single unavoidable assertion below narrow and local.
 */
type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];

const VOLUME_CHART_HEIGHT = 240;
/**
 * Bar charts size to their data instead of stretching a fixed height: with
 * four bronnen a 260px box turns each bar into a 60px slab, which reads as a
 * different chart type than the same component drawing ten locations.
 */
const BAR_THICKNESS = 18;
const BAR_BAND_HEIGHT = 34;
const BARS_CHART_PADDING = 20;
const BARS_CHART_MIN_HEIGHT = 140;
const BARS_CHART_MAX_HEIGHT = 320;
const HISTOGRAM_HEIGHT = 220;
const TOOLTIP_RADIUS = 6;
const AXIS_FONT_SIZE = 11;
const BAR_RADIUS = 3;
const CATEGORY_AXIS_WIDTH = 150;
const VALUE_AXIS_WIDTH = 40;

const tooltipStyle = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: `${TOOLTIP_RADIUS}px`,
  color: "var(--popover-foreground)",
  fontSize: "12px",
} as const;

const axis = {
  axisLine: false,
  fontSize: AXIS_FONT_SIZE,
  stroke: "var(--muted-foreground)",
  tickLine: false,
} as const;

const DASHBOARD_TIME_ZONE = "Europe/Amsterdam";

const weekLabelFormatter = new Intl.DateTimeFormat("nl-NL", {
  day: "2-digit",
  month: "short",
  timeZone: DASHBOARD_TIME_ZONE,
});

export interface WeekPoint {
  readonly count: number;
  readonly week: string;
}

export interface BarPoint {
  readonly href?: string;
  readonly name: string;
  readonly value: number;
}

export interface RateBucket {
  readonly bucket: number;
  readonly count: number;
}

export const WeeklyVolumeChart = ({
  data,
}: {
  readonly data: readonly WeekPoint[];
}) => {
  const formatted = useMemo(
    () =>
      data.map(({ count, week }) => ({
        count,
        label: weekLabelFormatter.format(new Date(week)),
      })),
    [data]
  );

  return (
    <ResponsiveContainer width="100%" height={VOLUME_CHART_HEIGHT}>
      <AreaChart
        data={formatted}
        margin={{ bottom: 0, left: -18, right: 4, top: 4 }}
      >
        <defs>
          <linearGradient id="ji-volume" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--border)"
          vertical={false}
        />
        <XAxis dataKey="label" {...axis} minTickGap={16} />
        <YAxis {...axis} width={VALUE_AXIS_WIDTH} allowDecimals={false} />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ stroke: "var(--border)" }}
        />
        <Area
          type="monotone"
          dataKey="count"
          name="Opdrachten"
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="url(#ji-volume)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};

export const HorizontalBars = ({
  data,
  linkListLabel,
}: {
  readonly data: readonly BarPoint[];
  /** Names the keyboard-reachable link list that mirrors the clickable bars. */
  readonly linkListLabel: string;
}) => {
  const router = useRouter();
  const height = Math.min(
    BARS_CHART_MAX_HEIGHT,
    Math.max(
      BARS_CHART_MIN_HEIGHT,
      data.length * BAR_BAND_HEIGHT + BARS_CHART_PADDING
    )
  );
  const hrefByName = new Map(
    data
      .filter((point): point is BarPoint & { href: string } =>
        Boolean(point.href)
      )
      .map((point) => [point.name, point.href])
  );

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={[...data]}
          layout="vertical"
          margin={{ bottom: 0, left: 8, right: 16, top: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            horizontal={false}
          />
          <XAxis type="number" {...axis} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="name"
            {...axis}
            width={CATEGORY_AXIS_WIDTH}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            cursor={{ fill: "var(--accent)", opacity: 0.4 }}
          />
          <Bar
            dataKey="value"
            name="Opdrachten"
            barSize={BAR_THICKNESS}
            radius={[0, BAR_RADIUS, BAR_RADIUS, 0]}
            cursor={hrefByName.size > 0 ? "pointer" : undefined}
            onClick={(entry: { name?: string }) => {
              const href = entry.name ? hrefByName.get(entry.name) : undefined;
              if (href) {
                // SAFETY: every href in this map is built in this app as the
                // literal /jobs route plus one encodeURIComponent'd filter
                // value, so it is always a valid internal route.
                router.push(href as RouterPushTarget);
              }
            }}
          >
            {data.map(({ name }, index) => (
              <Cell
                key={name}
                fill={CHART_COLORS[index % CHART_COLORS.length]}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/*
        Recharts bars are SVG shapes: clickable, never focusable. This list
        gives keyboard and screen-reader users the same jump into /jobs that
        a mouse user gets from a bar, without duplicating anything visually.
      */}
      {hrefByName.size > 0 ? (
        <ul className="sr-only" aria-label={linkListLabel}>
          {data.map(({ href, name, value }) =>
            href ? (
              <li key={name}>
                <a href={href}>
                  {name}: {value} opdrachten
                </a>
              </li>
            ) : null
          )}
        </ul>
      ) : null}
    </div>
  );
};

export const RateHistogram = ({
  data,
}: {
  readonly data: readonly RateBucket[];
}) => {
  const formatted = data.map(({ bucket, count }) => ({
    count,
    label: `€${bucket}`,
  }));

  return (
    <ResponsiveContainer width="100%" height={HISTOGRAM_HEIGHT}>
      <BarChart
        data={formatted}
        margin={{ bottom: 0, left: -18, right: 4, top: 4 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--border)"
          vertical={false}
        />
        <XAxis dataKey="label" {...axis} minTickGap={8} />
        <YAxis {...axis} width={VALUE_AXIS_WIDTH} allowDecimals={false} />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ fill: "var(--accent)", opacity: 0.4 }}
        />
        <Bar
          dataKey="count"
          name="Opdrachten"
          fill="var(--chart-2)"
          radius={[BAR_RADIUS, BAR_RADIUS, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
};

const TREND_CHART_HEIGHT = 260;
const SPARKLINE_HEIGHT = 36;
const dayLabelFormatter = new Intl.DateTimeFormat("nl-NL", {
  day: "2-digit",
  month: "short",
  timeZone: DASHBOARD_TIME_ZONE,
});

export interface BronTrendPoint {
  readonly bucket: string;
  readonly failed: number;
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly rejected: number;
}

export interface BronSparkPoint {
  readonly bucket: string;
  readonly nieuw: number;
}

const SparklineWidthContext = createContext<number>(0);

/**
 * One shared width measurement for every bronkaart sparkline.
 * Observes the grid host and reads the first card column width so we do not
 * mount a ResponsiveContainer (and ResizeObserver) per card.
 */
export const SparklineWidthProvider = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || globalThis.ResizeObserver === undefined) {
      return;
    }
    const readWidth = () => {
      const card = host.querySelector<HTMLElement>("[data-bron-card]");
      const next = card?.clientWidth ?? 0;
      if (next > 0) {
        // CardContent uses px-(--card-spacing); default --spacing(4) => 16px each side.
        setWidth(Math.max(0, next - 32));
      }
    };
    readWidth();
    const observer = new ResizeObserver(() => {
      readWidth();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={hostRef} className="w-full">
      <SparklineWidthContext.Provider value={width}>
        {children}
      </SparklineWidthContext.Provider>
    </div>
  );
};

/**
 * Total trend: stacked nieuw/gewijzigd/rejected areas + failed line.
 * Reuses WeeklyVolumeChart tooltip/axis tokens (`--chart-*`, dark-mode popover).
 */
export const BronTrendChart = ({
  data,
}: {
  readonly data: readonly BronTrendPoint[];
}) => {
  const formatted = useMemo(
    () =>
      data.map((point) => ({
        ...point,
        label: dayLabelFormatter.format(new Date(point.bucket)),
      })),
    [data]
  );

  if (formatted.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nog geen trenddata in dit venster.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={TREND_CHART_HEIGHT}>
      <ComposedChart
        data={formatted}
        margin={{ bottom: 0, left: -18, right: 4, top: 8 }}
      >
        <defs>
          <linearGradient id="ji-bron-nieuw" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.55} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="ji-bron-gewijzigd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0.05} />
          </linearGradient>
          <linearGradient id="ji-bron-rejected" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-4)" stopOpacity={0.45} />
            <stop offset="100%" stopColor="var(--chart-4)" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--border)"
          vertical={false}
        />
        <XAxis dataKey="label" {...axis} minTickGap={16} />
        <YAxis {...axis} width={VALUE_AXIS_WIDTH} allowDecimals={false} />
        <Tooltip
          contentStyle={tooltipStyle}
          cursor={{ stroke: "var(--border)" }}
        />
        <Area
          type="monotone"
          dataKey="nieuw"
          name="Nieuw"
          stackId="volume"
          stroke="var(--chart-1)"
          strokeWidth={1.5}
          fill="url(#ji-bron-nieuw)"
        />
        <Area
          type="monotone"
          dataKey="gewijzigd"
          name="Gewijzigd"
          stackId="volume"
          stroke="var(--chart-2)"
          strokeWidth={1.5}
          fill="url(#ji-bron-gewijzigd)"
        />
        <Area
          type="monotone"
          dataKey="rejected"
          name="Rejected"
          stackId="volume"
          stroke="var(--chart-4)"
          strokeWidth={1.5}
          fill="url(#ji-bron-rejected)"
        />
        <Line
          type="monotone"
          dataKey="failed"
          name="Failed"
          stroke="var(--chart-5)"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

/**
 * Compact per-bron sparkline. Width comes from SparklineWidthProvider so a
 * 12-card grid does not mount 12 ResponsiveContainers (layout thrash).
 */
export const BronSparkline = ({
  data,
  label,
}: {
  readonly data: readonly BronSparkPoint[];
  readonly label: string;
}) => {
  const width = useContext(SparklineWidthContext);

  if (data.length === 0) {
    return <p className="text-[11px] text-muted-foreground">Geen sparkline</p>;
  }

  if (width <= 0) {
    return (
      <div
        aria-hidden
        className="h-9 w-full rounded bg-muted/40"
        style={{ height: SPARKLINE_HEIGHT }}
      />
    );
  }

  const gradientId = `ji-spark-${label.replaceAll(/[^a-zA-Z0-9_-]+/gu, "-")}`;

  return (
    <div aria-label={label} role="img">
      <AreaChart
        width={width}
        height={SPARKLINE_HEIGHT}
        data={[...data]}
        margin={{ bottom: 0, left: 0, right: 0, top: 2 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.45} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="nieuw"
          stroke="var(--chart-1)"
          strokeWidth={1.25}
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </div>
  );
};
