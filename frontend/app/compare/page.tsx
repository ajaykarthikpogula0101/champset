"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Side-by-side compare view for the blind A/B test.
 *
 * Pick any two of your Sets and see them next to each other: row counts,
 * column counts, the neutral Variation label, and the full tables. Build the
 * same prompt as Variation A and Variation B, then judge them here on coverage,
 * accuracy, and structure. The page is deep-linkable via ?a=<id>&b=<id> so a
 * comparison can be shared. It reuses the same owner-scoped Convex queries the
 * dashboard uses, so it never exposes another user's data.
 */
export default function ComparePage() {
  return (
    <Suspense fallback={<CenterSpinner />}>
      <CompareInner />
    </Suspense>
  );
}

function CompareInner() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();
  const params = useSearchParams();
  const aId = params.get("a") ?? "";
  const bId = params.get("b") ?? "";

  const sets = useQuery(api.datasets.listMine, isAuthenticated ? {} : "skip");

  function setSide(side: "a" | "b", id: string) {
    const next = new URLSearchParams(params.toString());
    if (id) next.set(side, id);
    else next.delete(side);
    router.replace(`/compare?${next.toString()}`);
  }

  if (isLoading || (isAuthenticated && sets === undefined)) {
    return <CenterSpinner />;
  }

  const options = (sets ?? []).map((s) => ({
    id: s._id as string,
    name: s.name as string,
    variation:
      (s as { searchProvider?: string }).searchProvider === "exa"
        ? "Variation B"
        : "Variation A",
  }));

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="text-sm font-semibold text-accent">
            ChampSet
          </Link>
          <span className="text-muted">/</span>
          <span className="text-sm font-medium text-foreground">Compare</span>
        </div>
        <Link
          href="/dashboard"
          className="text-xs font-medium text-muted hover:text-foreground"
        >
          Back to dashboard
        </Link>
      </header>

      <div className="mx-auto w-full max-w-[1400px] px-4 py-5">
        <p className="mb-4 text-[13px] leading-relaxed text-muted">
          Pick two Sets to compare side by side. To run a fair A/B test, build
          the same description as Variation A and Variation B, then compare them
          here on coverage, accuracy, and how clean the columns are.
        </p>

        {options.length < 2 && (
          <div className="mb-4 rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-muted">
            You need at least two Sets to compare. Build another from the{" "}
            <Link href="/dashboard" className="text-accent hover:underline">
              dashboard
            </Link>
            .
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CompareSide
            label="Left"
            options={options}
            selectedId={aId}
            otherId={bId}
            onSelect={(id) => setSide("a", id)}
          />
          <CompareSide
            label="Right"
            options={options}
            selectedId={bId}
            otherId={aId}
            onSelect={(id) => setSide("b", id)}
          />
        </div>
      </div>
    </div>
  );
}

type Opt = { id: string; name: string; variation: string };

function CompareSide({
  label,
  options,
  selectedId,
  otherId,
  onSelect,
}: {
  label: string;
  options: Opt[];
  selectedId: string;
  otherId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {label}
        </span>
        <select
          value={selectedId}
          onChange={(e) => onSelect(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-foreground/30"
        >
          <option value="">Select a Set...</option>
          {options.map((o) => (
            <option key={o.id} value={o.id} disabled={o.id === otherId}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
      {selectedId ? (
        <SetPanel datasetId={selectedId} />
      ) : (
        <div className="flex h-64 items-center justify-center text-[13px] text-muted">
          Choose a Set to display.
        </div>
      )}
    </div>
  );
}

function SetPanel({ datasetId }: { datasetId: string }) {
  const dataset = useQuery(api.datasets.get, {
    id: datasetId as Id<"datasets">,
  });
  const rows = useQuery(api.datasetRows.listByDataset, {
    datasetId: datasetId as Id<"datasets">,
  });

  if (dataset === undefined || rows === undefined) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span
          aria-hidden
          className="h-6 w-6 rounded-full border-2 border-border border-t-accent animate-spin"
        />
      </div>
    );
  }
  if (dataset === null) {
    return (
      <div className="flex h-64 items-center justify-center text-[13px] text-muted">
        This Set is no longer available.
      </div>
    );
  }

  const columns = (dataset.columns ?? []) as { name: string; type: string }[];
  const variation =
    (dataset as { searchProvider?: string }).searchProvider === "exa"
      ? "Variation B"
      : "Variation A";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <h2 className="mr-1 truncate text-sm font-semibold text-foreground">
          {dataset.name}
        </h2>
        <span
          className="rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-muted"
          title="Build variation (blind A/B test)"
        >
          {variation}
        </span>
        <span className="text-[11px] text-muted">{rows.length} rows</span>
        <span className="text-[11px] text-muted">{columns.length + 1} columns</span>
      </div>
      <CompareTable columns={columns} rows={rows} />
    </div>
  );
}

function CompareTable({
  columns,
  rows,
}: {
  columns: { name: string; type: string }[];
  rows: Array<{
    _id: string;
    data?: Record<string, unknown>;
    accuracyScore?: number;
  }>;
}) {
  if (rows.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-[13px] text-muted">
        No rows yet.
      </div>
    );
  }
  return (
    <div className="max-h-[62vh] overflow-auto border-t border-border">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            {columns.map((c) => (
              <th
                key={c.name}
                className="border-b border-r border-border px-2.5 py-1.5 text-left font-semibold text-muted whitespace-nowrap"
              >
                {c.name}
              </th>
            ))}
            <th
              className="border-b border-border px-2.5 py-1.5 text-left font-semibold text-muted whitespace-nowrap"
              title="Model confidence (0-100) derived from token logprobs"
            >
              Accuracy Score
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row._id} className="hover:bg-foreground/[0.03]">
              {columns.map((c) => (
                <td
                  key={c.name}
                  className="max-w-[260px] truncate border-b border-r border-border px-2.5 py-1.5 align-top text-foreground"
                  title={cellText(row.data?.[c.name])}
                >
                  {cellText(row.data?.[c.name])}
                </td>
              ))}
              <td className="border-b border-border px-2.5 py-1.5 align-top text-foreground">
                {row.accuracyScore ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function CenterSpinner() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <span
        aria-hidden
        className="h-8 w-8 rounded-full border-2 border-border border-t-accent animate-spin"
      />
      <span className="sr-only">Loading</span>
    </div>
  );
}
