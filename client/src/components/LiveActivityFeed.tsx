import { CheckCircle, XCircle, Activity, Gauge, Timer, ListChecks } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export interface LiveActivityEntry {
  url: string;
  ok: boolean;
  message?: string;
  timestamp: number;
}

interface LiveActivityFeedProps {
  feed: LiveActivityEntry[];
  processedCount: number;
  pagesPerMinute: number | null;
  etaMs: number | null;
  t: (key: any) => string;
}

function formatEta(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes < 1) return '< 1 min';
  if (totalMinutes < 60) return `~${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `~${hours} h ${minutes} min`;
}

function shortPath(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.hash || '');
    return path === '/' || path === '' ? u.hostname : path;
  } catch {
    return url;
  }
}

export default function LiveActivityFeed({ feed, processedCount, pagesPerMinute, etaMs, t }: LiveActivityFeedProps) {
  return (
    <div className="mt-3 pt-3 border-t border-border/50" data-testid="live-activity-feed">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Activity className="w-3.5 h-3.5 text-primary" />
          {t('liveActivity')}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-session-processed">
          <ListChecks className="w-3.5 h-3.5" />
          {t('processedInSession')}: <span className="font-semibold text-foreground">{processedCount}</span>
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-pages-per-minute">
          <Gauge className="w-3.5 h-3.5" />
          {pagesPerMinute !== null ? (
            <>
              <span className="font-semibold text-foreground">{pagesPerMinute >= 10 ? Math.round(pagesPerMinute) : pagesPerMinute.toFixed(1)}</span> {t('pagesPerMinute')}
            </>
          ) : (
            t('calculatingEta')
          )}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-eta">
          <Timer className="w-3.5 h-3.5" />
          {t('estimatedTimeLeft')}: <span className="font-semibold text-foreground">{etaMs !== null ? formatEta(etaMs) : t('calculatingEta')}</span>
        </span>
      </div>
      <div className="max-h-36 overflow-y-auto rounded-md bg-background/60 border border-border/50">
        {feed.length === 0 ? (
          <p className="text-xs text-muted-foreground px-3 py-2">{t('waitingForActivity')}</p>
        ) : (
          <ul className="divide-y divide-border/40">
            {feed.map((entry, idx) => (
              <li key={`${entry.timestamp}-${idx}`} className="flex items-center gap-2 px-3 py-1 text-xs" data-testid={`activity-entry-${idx}`}>
                {entry.ok ? (
                  <CheckCircle className="w-3 h-3 shrink-0 text-emerald-500" />
                ) : entry.message ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <XCircle className="w-3 h-3 shrink-0 text-red-500 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <p className="text-xs">{entry.message}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <XCircle className="w-3 h-3 shrink-0 text-red-500" />
                )}
                <span className="truncate flex-1 text-foreground/90" title={entry.url}>{shortPath(entry.url)}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                  {new Date(entry.timestamp).toLocaleTimeString('de-DE')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
