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
 * Dashboard build-variation switch. Flips the signed-in user's default web
 * engine between the owned SearXNG pipeline and Exa. For the blind A/B test the
 * UI labels these neutrally as "Variation A" (searxng) and "Variation B" (exa)
 * so raters never see which engine built a Set. The real engine is still saved
 * to modelConfig.searchProvider and tagged on every run (runStats) for
 * de-blinded analysis by the data team.
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
        Variant
      </span>
      <div
        role="group"
        aria-label="Build variation"
        className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5"
      >
        <EngineSegment
          engine="searxng"
          label="Variation A"
          hint="Build variation A (blind A/B test)."
          active={active}
          onChoose={choose}
        />
        <EngineSegment
          engine="exa"
          label="Variation B"
          hint="Build variation B (blind A/B test)."
          active={active}
          onChoose={choose}
        />
      </div>
    </div>
  );
}
