import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import StatsCards from '@/components/StatsCards';
import { projectResultsQuery, projectResultsSummaryQuery } from '@/lib/project-result-queries';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function ResultsView() {
  const { data: summary } = useQuery(projectResultsSummaryQuery(42));
  const { data: page } = useQuery(projectResultsQuery(42, '/api/projects/42/results?offset=0&limit=500'));
  return <>
    <StatsCards {...summary} t={key => key} />
    {(summary?.pendingCount ?? 0) > 0 && <button>Extraktion starten</button>}
    <ul>{page?.results.map(result => <li key={result.loc}>{result.loc}</li>)}</ul>
  </>;
}

describe('project result cache updates', () => {
  it('shows discovered URLs, counts and extraction action after sitemap progress without reopening the project', async () => {
    let count = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('results-summary')
        ? { urlCount: count, scrapedCount: 0, failedCount: 0, pendingCount: count, attachmentCount: 0, folders: [] }
        : { total: count, results: count ? [{ loc: 'https://www.kita-funktionsstellen.bayern/informationen/' }] : [] },
    ), { status: 200 })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<QueryClientProvider client={client}><ResultsView /></QueryClientProvider>);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByTestId('text-urls-found')).toHaveTextContent('0');
    expect(screen.queryByRole('button', { name: 'Extraktion starten' })).not.toBeInTheDocument();

    count = 20;
    // Same invalidation used by sitemap/crawl progress and content mutations.
    await client.invalidateQueries({ queryKey: ['/api/projects'] });
    await waitFor(() => expect(screen.getByTestId('text-urls-found')).toHaveTextContent('20'));
    expect(screen.getByRole('button', { name: 'Extraktion starten' })).toBeInTheDocument();
    expect(screen.getByText('https://www.kita-funktionsstellen.bayern/informationen/')).toBeInTheDocument();
    client.clear();
  });

  it('refreshes all pages and summary for the changed project only, preserving request filters', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('results-summary') ? { urlCount: 20 } : { total: 20, results: [] },
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const urls = [
      '/api/projects/42/results?offset=0&limit=10',
      '/api/projects/42/results?offset=10&limit=10&search=bildung&folder=%2Finformationen',
    ];
    await Promise.all([
      ...urls.map(url => client.fetchQuery(projectResultsQuery(42, url))),
      client.fetchQuery(projectResultsSummaryQuery(42)),
      client.fetchQuery(projectResultsSummaryQuery(99)),
    ]);
    fetchMock.mockClear();
    await client.invalidateQueries({ queryKey: ['/api/projects', 42], refetchType: 'all' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const url of [...urls, '/api/projects/42/results-summary']) {
      expect(fetchMock).toHaveBeenCalledWith(url, expect.anything());
    }
    expect(fetchMock).not.toHaveBeenCalledWith('/api/projects/99/results-summary', expect.anything());
    client.clear();
  });
});
