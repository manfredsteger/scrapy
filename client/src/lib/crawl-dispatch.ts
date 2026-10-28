import type { QueryClient } from '@tanstack/react-query';
import type { Project } from '@shared/schema';

export function activeProjectsForDispatch(client: QueryClient, fallback: Project[]) {
  return (client.getQueryData<Project[]>(['/api/projects']) ?? fallback)
    .filter(p => ['scraping', 'crawling', 'content_scraping'].includes(p.status));
}

export async function refreshAfterProjectWrite(client: QueryClient, data: unknown) {
  if (data !== null) {
    await client.invalidateQueries({ queryKey: ['/api/projects'] });
  }
}

export function scheduleAfterStep(
  id: number,
  pending: ReadonlyMap<number, unknown>,
  schedule: (id: number, delay: number) => void,
  minimumDelay: number,
) {
  if (!pending.has(id)) schedule(id, minimumDelay);
}
