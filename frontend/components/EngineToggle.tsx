"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

type Engine = "searxng" | "exa";

/**
 * One segment of the engine switch. Defined at module scope (not inside the
 * EngineToggle render) so its component identity is stable across renders.
 * The active engine and the change handler are passed in as props.
 */
function EngineSegment({
  engine,
  label,
  hint,
  active,
  onChoose,
}: {
  engine: Engine;
  label: string;
  hint: string;
  active: Engine;
  onChoose: (engine: Engine) => void;
}) {
  const on = active === engine;
  return (
    <button
      type="button"
      onClick={() => onChoose(engine)}
      aria-pressed={on}
      title={hint}
      className={[
        "px-3 py-1.5 text-xs font-semibold rounded-md transition-colors duration-150",
        on ? "bg-accent text-accent-text" : "text-muted hover:text-foreground",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

/**
 * Dashboard discovery-engine switch. Flips the signed-in user's default web
 * engine between the owned SearXNG pipeline ("Proprietary") and Exa. The
 * choice is saved to modelConfig.searchProvider and applied to every new Set
 * the user builds; each run is tagged with the engine it used (runStats) so
 * the two can be compared during the bake-off.
 */
export function EngineToggle({ className = "" }: { className?: string }) {
  const { isAuthenticated } = useConvexAuth();
  const cfg = useQuery(api.modelConfig.get, isAuthenticated ? {} : "skip");
  const setConfig = useMutation(api.modelConfig.upsert);

  if (!isAuthenticated) return null;

  const active: Engine = cfg?.searchProvider === "exa" ? "exa" : "searxng";

  const choose = (engine: Engine) => {
    if (engine !== active) void setConfig({ searchProvider: engine });
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="text-[11px] uppercase tracking-wide text-muted hidden sm:inline">
        Engine
      </span>
      <div
        role="group"
        aria-label="Discovery engine"
        className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5"
      >
        <EngineSegment
          engine="searxng"
          label="Proprietary"
          hint="ChampSet owned engine: self-hosted SearXNG search + Readability fetch. No data API."
          active={active}
          onChoose={choose}
        />
        <EngineSegment
          engine="exa"
          label="Exa"
          hint="Exa engine: Exa neural search + contents for all web access."
          active={active}
          onChoose={choose}
        />
      </div>
    </div>
  );
}
