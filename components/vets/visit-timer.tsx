"use client";

import { useEffect, useState } from "react";
import { formatSlot } from "@/lib/vets/schedule";
import { durationLabel } from "./vet-parts";

/** "1:05:09" or "05:09". */
export function elapsedLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Time since the visit started, counted from the stored start of the
 * visit, so it carries on correctly after a reload. Nothing is saved while
 * it runs. The browser's clock is corrected by the server's time at render.
 * Screen readers get the start time once, not a tick every second.
 */
export function VisitTimer({
  startedAt,
  serverNow,
  plannedMinutes,
  running,
  endedAt = null,
}: {
  startedAt: string | null;
  serverNow: string;
  plannedMinutes: number | null;
  running: boolean;
  endedAt?: string | null;
}) {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const end = endedAt ? Date.parse(endedAt) : NaN;
  const [now, setNow] = useState(() => Date.parse(serverNow));

  useEffect(() => {
    if (!running || Number.isNaN(start)) return;
    const skew = Date.parse(serverNow) - Date.now();
    const tick = () => setNow(Date.now() + skew);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running, start, serverNow]);

  const planned = plannedMinutes ? `Planned length: ${durationLabel(plannedMinutes)}` : null;

  if (Number.isNaN(start))
    return (
      <div className="rounded-3xl bg-white px-4 py-4 text-center shadow-sm ring-1 ring-foreground/5">
        <p className="text-sm font-semibold">Elapsed time unavailable</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The start of this visit wasn&rsquo;t recorded, so the time spent can&rsquo;t be shown.
        </p>
        {planned && <p className="mt-1 text-xs text-muted-foreground">{planned}</p>}
      </div>
    );

  const elapsed = (running || Number.isNaN(end) ? now : end) - start;
  return (
    <div className="rounded-3xl bg-white px-4 py-4 text-center shadow-sm ring-1 ring-foreground/5">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {running ? "Time on this visit" : "Visit length"}
      </p>
      <p aria-hidden="true" className="mt-1 font-mono text-4xl font-semibold tabular-nums">
        {elapsedLabel(elapsed)}
      </p>
      <p className="sr-only">
        {running
          ? `Visit started ${formatSlot(new Date(start).toISOString())}.`
          : `Visit took ${elapsedLabel(elapsed)}.`}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Started {formatSlot(new Date(start).toISOString())}</p>
      {planned && <p className="mt-0.5 text-xs text-muted-foreground">{planned}</p>}
    </div>
  );
}
