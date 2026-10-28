import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Project } from '@shared/schema';
import { activeProjectsForDispatch, refreshAfterProjectWrite, scheduleAfterStep } from '@/lib/crawl-dispatch';

describe('crawl dispatcher completion', () => {
  it('waits for the list refetch and does not restart a finished project from a stale render', async () => {
    const client = new QueryClient();
    const oldRender = [{ id: 1, status: 'scraping', queue: [] }] as unknown as Project[];
    client.setQueryData(['/api/projects'], oldRender);
    let finishFetch!: (value: Project[]) => void;
    const observer = new QueryObserver(client, {
      queryKey: ['/api/projects'], staleTime: Infinity,
      queryFn: () => new Promise<Project[]>(resolve => { finishFetch = resolve; }),
    });
    const unsubscribe = observer.subscribe(() => {});
    let completed = false;
    const update = refreshAfterProjectWrite(client, {}).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finishFetch([{ ...oldRender[0], status: 'idle' }]);
    await update;
    expect(activeProjectsForDispatch(client, oldRender)).toEqual([]);
    unsubscribe();
    client.clear();
  });

  it('preserves existing per-project delays and defers retries after failures', () => {
    const schedule = vi.fn();
    scheduleAfterStep(1, new Map([[1, 'existing timer']]), schedule, 200);
    expect(schedule).not.toHaveBeenCalled();
    scheduleAfterStep(1, new Map(), schedule, 200);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(1, 200);
  });

  it('does not refetch for an aborted write', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await refreshAfterProjectWrite(client, null);
    expect(invalidate).not.toHaveBeenCalled();
    client.clear();
  });
});
