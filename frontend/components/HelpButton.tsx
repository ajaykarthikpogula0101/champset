"use client";

import { useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";

/**
 * Floating help button (bottom-right) + slide-over documentation panel.
 *
 * Mounted globally for signed-in users (see app/layout.tsx). The copy is
 * written for non-engineer pilot testers and is deliberately blind to which
 * build engine sits behind Variation A vs Variation B, so it never biases the
 * A/B comparison. Keep it that way: describe the two variations as two build
 * methods to compare, never name the underlying engine.
 */
export function HelpButton() {
  const { isAuthenticated } = useConvexAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Pilot helper: only show for signed-in testers, so it never appears on the
  // marketing landing or auth pages.
  if (!isAuthenticated) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Help and documentation"
        className="fixed bottom-5 right-5 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-text shadow-lg ring-1 ring-black/10 transition-transform hover:scale-105 active:scale-95"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="Help and documentation"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="relative flex h-full w-full flex-col bg-surface shadow-2xl lg:w-[460px] lg:border-l lg:border-border animate-slide-in">
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3.5">
              <h2 className="text-sm font-semibold text-foreground">
                ChampSet help
              </h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close help"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 text-[13px] leading-relaxed text-foreground">
              <Section title="What ChampSet does">
                <p className="text-muted">
                  Describe a dataset in plain English and ChampSet researches the
                  web and fills it in with real, sourced rows. Each row links back
                  to where the data was found.
                </p>
              </Section>

              <Section title="Build a Set in 4 steps">
                <ol className="ml-4 list-decimal space-y-1.5 text-muted">
                  <li>
                    Click <Kbd>New Set</Kbd> and describe what you want (for
                    example, &quot;B2B data consumer companies in Japan with
                    revenue and headcount&quot;).
                  </li>
                  <li>
                    Review the columns ChampSet proposes. Add, remove, or rename
                    them. Mark the column that uniquely identifies each row as the
                    primary key.
                  </li>
                  <li>
                    Choose <strong className="text-foreground">Variation A</strong>{" "}
                    or <strong className="text-foreground">Variation B</strong> on
                    the build button (see below), then start the build.
                  </li>
                  <li>
                    Watch rows stream in live. You can keep using the app while it
                    builds.
                  </li>
                </ol>
              </Section>

              <Section title="Variation A vs Variation B (the test)">
                <p className="text-muted">
                  Every Set is built by one of two methods, labelled{" "}
                  <strong className="text-foreground">Variation A</strong> and{" "}
                  <strong className="text-foreground">Variation B</strong>. We are
                  comparing them head to head.
                </p>
                <p className="mt-2 text-muted">
                  To compare fairly, build the{" "}
                  <strong className="text-foreground">same</strong> Set twice, once
                  as A and once as B, then judge them on row quality, accuracy of
                  the values, how many rows came back, and how long it took. This
                  is a blind test, so do not assume one variation is &quot;the good
                  one&quot; before you look.
                </p>
              </Section>

              <Section title="What to expect">
                <ul className="ml-4 list-disc space-y-1.5 text-muted">
                  <li>
                    A build usually takes about 1 to 5 minutes depending on how
                    many rows you ask for.
                  </li>
                  <li>
                    Rows appear as they are found, so the count climbs during the
                    build.
                  </li>
                  <li>
                    Some Sets return fewer rows than requested if the web simply
                    does not have that many clean matches. That is normal.
                  </li>
                  <li>The two variations can return different rows. That is the point.</li>
                </ul>
              </Section>

              <Section title="If a build fails or stalls">
                <ul className="ml-4 list-disc space-y-1.5 text-muted">
                  <li>
                    A Set marked <strong className="text-foreground">Failed</strong>{" "}
                    shows the reason underneath it. Re-running it usually works.
                  </li>
                  <li>
                    If the reason mentions a usage or budget limit, the shared AI
                    budget for the week has been spent. Let the admin know and they
                    will raise it.
                  </li>
                  <li>
                    If a Set sits on <strong className="text-foreground">Building</strong>{" "}
                    for more than about 10 minutes, refresh the page; if it is still
                    stuck, start it again.
                  </li>
                </ul>
              </Section>

              <Section title="Your account">
                <p className="text-muted">
                  Sign in with your own email so your Sets stay separate from your
                  teammates&apos;. Several people can use the app at the same time.
                  Account deletion is turned off during the pilot, so you cannot
                  remove your account from here.
                </p>
              </Section>

              <Section title="Need a hand?">
                <p className="text-muted">
                  Email{" "}
                  <a
                    href="mailto:deep@championsmail.com"
                    className="font-medium text-accent hover:underline"
                  >
                    deep@championsmail.com
                  </a>{" "}
                  with the Set name and what you saw.
                </p>
              </Section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground">
      {children}
    </span>
  );
}
