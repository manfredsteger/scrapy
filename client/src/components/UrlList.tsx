import { useState, useMemo } from 'react';
import { ExternalLink, CheckCircle, Clock, Search, Eye, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import ContentPreview from './ContentPreview';
import type { SitemapUrlEntry } from '@shared/schema';

interface UrlListProps {
  urls: SitemapUrlEntry[];
  t: (key: any) => string;
}

export default function UrlList({ urls, t }: UrlListProps) {
  const [filter, setFilter] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<SitemapUrlEntry | null>(null);
  const [showFolders, setShowFolders] = useState(false);
  
  const folderStats = useMemo(() => {
    const stats: Record<string, number> = {};
    urls.forEach(url => {
      try {
        const path = new URL(url.loc).pathname;
        const segments = path.split('/').filter(s => s.length > 0);
        if (segments.length > 0) {
          const firstSegment = `/${segments[0]}/`;
          stats[firstSegment] = (stats[firstSegment] || 0) + 1;
        } else {
          stats['/'] = (stats['/'] || 0) + 1;
        }
      } catch {}
    });
    return Object.entries(stats).sort((a, b) => b[1] - a[1]);
  }, [urls]);

  const filteredUrls = useMemo(() => {
    let result = urls;
    if (activeFolder) {
      if (activeFolder === '/') {
        result = result.filter(u => {
          try {
            const path = new URL(u.loc).pathname;
            return path === '/' || path === '';
          } catch {
            return false;
          }
        });
      } else {
        result = result.filter(u => {
          try {
            return new URL(u.loc).pathname.startsWith(activeFolder);
          } catch {
            return false;
          }
        });
      }
    }
    if (filter) {
      const lower = filter.toLowerCase();
      result = result.filter(u => u.loc.toLowerCase().includes(lower));
    }
    return result;
  }, [urls, filter, activeFolder]);

  return (
    <div className="flex flex-col h-full">
      {previewEntry && previewEntry.scrapedData && (
        <ContentPreview 
          entry={previewEntry} 
          onClose={() => setPreviewEntry(null)} 
          t={t}
        />
      )}

      <div className="p-4 border-b border-border bg-card space-y-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              type="text" 
              placeholder={t('searchPlaceholder')}
              className="pl-9 bg-input border-border"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              data-testid="search-input"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFolders(!showFolders)}
            className="gap-2"
          >
            Filter <ChevronDown className={`w-4 h-4 transition-transform ${showFolders ? 'rotate-180' : ''}`} />
          </Button>
        </div>
        
        {showFolders && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setActiveFolder(null)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                !activeFolder 
                  ? 'bg-primary text-primary-foreground' 
                  : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
              data-testid="filter-all"
            >
              Alle ({urls.length})
            </button>
            {folderStats.slice(0, 12).map(([folder, count]) => (
              <button
                key={folder}
                onClick={() => setActiveFolder(activeFolder === folder ? null : folder)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  activeFolder === folder 
                    ? 'bg-primary text-primary-foreground' 
                    : 'bg-secondary text-secondary-foreground hover:bg-accent'
                }`}
                data-testid={`filter-${folder}`}
              >
                {folder} ({count})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <table className="data-table w-full table-fixed">
          <thead className="sticky top-0 bg-card z-10">
            <tr>
              <th className="text-left" style={{ width: '55%' }}>{t('targetPath')}</th>
              <th className="text-left" style={{ width: '15%' }}>Datum</th>
              <th className="text-left" style={{ width: '15%' }}>{t('status')}</th>
              <th className="text-right" style={{ width: '15%' }}>{t('action')}</th>
            </tr>
          </thead>
          <tbody>
            {filteredUrls.slice(0, 500).map((url, idx) => {
              let displayPath = url.loc;
              try {
                displayPath = new URL(url.loc).pathname || '/';
              } catch {}
              
              // Truncate long paths for display
              const maxLength = 50;
              const truncatedPath = displayPath.length > maxLength 
                ? displayPath.slice(0, maxLength) + '...' 
                : displayPath;
              const needsTruncation = displayPath.length > maxLength;
              
              return (
                <tr key={idx} data-testid={`url-row-${idx}`}>
                  <td className="overflow-hidden">
                    <div className="flex items-center gap-2 min-w-0">
                      {needsTruncation ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span 
                              className="text-sm font-medium text-foreground cursor-help truncate block max-w-full"
                              data-testid={`text-url-truncated-${idx}`}
                            >
                              {truncatedPath}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-md break-all" data-testid={`text-url-full-${idx}`}>
                            <p className="text-xs">{displayPath}</p>
                            <p className="text-[10px] text-muted-foreground mt-1">{url.loc}</p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span 
                          className="text-sm font-medium text-foreground truncate block max-w-full" 
                          title={url.loc}
                          data-testid={`text-url-${idx}`}
                        >
                          {displayPath}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    {url.lastmod ? (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3 shrink-0" />
                        <span className="whitespace-nowrap">{new Date(url.lastmod).toLocaleDateString('de-DE')}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                  <td>
                    {url.scrapedData ? (
                      <span className="badge-green whitespace-nowrap">
                        <CheckCircle className="w-3 h-3 shrink-0" />
                        Scraped
                      </span>
                    ) : (
                      <span className="badge-gray whitespace-nowrap">Pending</span>
                    )}
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {url.scrapedData && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPreviewEntry(url)}
                          data-testid={`view-content-${idx}`}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                      )}
                      <a href={url.loc} target="_blank" rel="noopener noreferrer">
                        <Button variant="ghost" size="icon" data-testid={`external-link-${idx}`}>
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        
        {filteredUrls.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-muted-foreground">{t('noProjects')}</p>
          </div>
        )}
        
        {filteredUrls.length > 500 && (
          <div className="py-4 text-center border-t border-border">
            <p className="text-sm text-muted-foreground">
              Showing 500 of {filteredUrls.length} URLs
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
