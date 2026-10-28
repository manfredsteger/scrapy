import { queryOptions } from '@tanstack/react-query';
import type { SitemapUrlEntry } from '@shared/schema';
import { apiRequest } from './queryClient';

export interface ProjectResultsSummary {
  urlCount: number;
  scrapedCount: number;
  failedCount: number;
  pendingCount: number;
  attachmentCount: number;
  folders: Array<[string, number]>;
}

// Keep result queries under the same prefix as project metadata so existing
// progress/mutation invalidations refresh counts AND every cached results page.
// The request URL stays separate: joining these keys would break pagination.
export function projectResultsQuery(projectId: number | null, url: string | null) {
  return queryOptions({
    queryKey: ['/api/projects', projectId, 'results', url],
    queryFn: async (): Promise<{ results: SitemapUrlEntry[]; total: number }> => {
      const response = await apiRequest('GET', url!);
      return response.json();
    },
    enabled: projectId !== null && url !== null,
    staleTime: 2000,
  });
}

export function projectResultsSummaryQuery(projectId: number | null) {
  return queryOptions({
    queryKey: ['/api/projects', projectId, 'results-summary'],
    queryFn: async (): Promise<ProjectResultsSummary> => {
      const response = await apiRequest('GET', `/api/projects/${projectId}/results-summary`);
      return response.json();
    },
    enabled: projectId !== null,
    staleTime: 2000,
  });
}
