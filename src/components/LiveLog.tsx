"use client";

import { useEffect, useRef, useState } from "react";
import type { FeedItem } from "@/lib/feed";

const POLL_INTERVAL_MS = 3000;

const JOB_STATUS_STYLE: Record<string, string> = {
  succeeded: "text-green-700 dark:text-green-400",
  running: "text-blue-700 dark:text-blue-400",
  pending: "text-muted",
  retrying: "text-amber-700 dark:text-amber-400",
  dead: "text-red-700 dark:text-red-400",
};

function describeInteraction(item: FeedItem): string {
  if (item.type === 2) return `/${item.command ?? "?"}`;
  if (item.type === 3) return `button: ${item.customId ?? "?"}`;
  if (item.type === 5) return `modal: ${item.customId ?? "?"}`;
  return `type ${item.type}`;
}

export function LiveLog({ guildId, initialItems }: { guildId: string; initialItems: FeedItem[] }) {
  const [items, setItems] = useState<FeedItem[]>(initialItems);
  const [isLive, setIsLive] = useState(true);
  const cursorRef = useRef<string | undefined>(initialItems.at(-1)?.createdAt);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      if (document.hidden) return; // pause while the tab isn't visible
      try {
        const url = new URL(`/api/guilds/${guildId}/feed`, window.location.origin);
        if (cursorRef.current) url.searchParams.set("after", cursorRef.current);
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          setIsLive(false);
          return;
        }
        setIsLive(true);
        const { items: fresh } = (await res.json()) as { items: FeedItem[] };
        if (cancelled || fresh.length === 0) return;
        cursorRef.current = fresh.at(-1)!.createdAt;
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...fresh.filter((i) => !seen.has(i.id))];
        });
      } catch {
        setIsLive(false);
      }
    }

    const interval = setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [guildId]);

  const newestFirst = [...items].reverse();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className={`inline-block h-2 w-2 rounded-full ${isLive ? "animate-pulse bg-green-500" : "bg-red-500"}`} />
        {isLive ? "Live" : "Connection lost — retrying"}
      </div>

      {newestFirst.length === 0 ? (
        <p className="card text-sm text-muted">
          No commands recorded yet. Run /report or /status in the server to see it appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {newestFirst.map((item) => (
            <li key={item.id} className="card p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-mono font-medium">{describeInteraction(item)}</span>
                <span className="text-xs text-muted">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="text-xs text-muted">
                {item.username ?? item.userId ?? "unknown user"} · {item.status}
                {item.duplicateCount > 0 && ` · ${item.duplicateCount} duplicate deliver(ies) ignored`}
              </div>
              {item.ruleMatches.length > 0 && (
                <div className="mt-1 text-xs text-muted">Rule applied: {item.ruleMatches.join("; ")}</div>
              )}
              {item.jobs.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 border-l-2 border-border pl-3">
                  {item.jobs.map((job) => (
                    <li key={job.id} className="text-xs [overflow-wrap:anywhere]">
                      <span className="font-mono">{job.kind}</span>{" "}
                      <span className={JOB_STATUS_STYLE[job.status] ?? ""}>{job.status}</span>
                      {job.attempts > 0 && ` · attempt ${job.attempts}/${job.maxAttempts}`}
                      {job.status === "retrying" && ` · next try ${new Date(job.runAt).toLocaleTimeString()}`}
                      {job.lastError && <span className="text-red-600"> · {job.lastError}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
