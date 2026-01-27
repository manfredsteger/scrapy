import { useState, useMemo } from 'react';
import { ExternalLink, Clock, Image as ImageIcon, Search, CheckCircle, ScanText, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import ContentPreview from './ContentPreview';
import type { SitemapUrlEntry } from '@shared/schema';

interface UrlListProps {
  urls: SitemapUrlEntry[];
  t: (key: any) => string;
}

function isLikelyContentPage(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path.endsWith('.php') || path.endsWith('.html') || path.endsWith('.htm') || path.endsWith('.aspx')) {
      return true;
    }
    const segments = path.split('/').filter(s => s.length > 0);
    if (path.endsWith('/') && segments.length <= 1 && segments[0] !== 'index') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export default function UrlList({ urls, t }: UrlListProps) {
  const [filter, setFilter] = useState('');
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [previewEntry, setPreviewEntry] = useState<SitemapUrlEntry | null>(null);
  
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
          stats['/ (Root)'] = (stats['/ (Root)'] || 0) + 1;
        }
      } catch {}
    });
    return Object.entries(stats).sort((a, b) => b[1] - a[1]);
  }, [urls]);

  const filteredUrls = useMemo(() => {
    let result = urls;
    if (activeFolder) {
      if (activeFolder === '/ (Root)') {
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
    <div className="flex flex-col relative">
      {previewEntry && previewEntry.scrapedData && (
        <ContentPreview 
          entry={previewEntry} 
          onClose={() => setPreviewEntry(null)} 
          t={t}
        />
      )}

      <div className="bg-muted/50 border-b border-border p-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant={!activeFolder && !filter ? 'default' : 'outline'}
            size="sm"
            onClick={() => { setActiveFolder(null); setFilter(''); }}
            className="text-xs font-bold uppercase tracking-wider"
            data-testid="filter-all"
          >
            {t('globalRepository')} ({urls.length})
          </Button>
          {folderStats.slice(0, 10).map(([folder, count]) => (
            <Button
              key={folder}
              variant={activeFolder === folder ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveFolder(activeFolder === folder ? null : folder)}
              className="text-xs font-bold uppercase tracking-wider gap-2"
              data-testid={`filter-${folder}`}
            >
              <span>{folder}</span>
              <Badge variant="secondary" className="text-[10px] px-1.5">
                {count}
              </Badge>
            </Button>
          ))}
        </div>
      </div>

      <div className="p-4 border-b border-border bg-card sticky top-0 z-20">
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            type="text" 
            placeholder={t('searchPlaceholder')}
            className="pl-11"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="search-input"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-muted/50 text-muted-foreground text-[10px] font-bold uppercase tracking-widest border-b border-border">
              <th className="px-6 py-4">{t('targetPath')}</th>
              <th className="px-4 py-4">{t('sitemapMetadata')}</th>
              <th className="px-4 py-4">{t('deepExtractionCol')}</th>
              <th className="px-6 py-4 text-right">{t('action')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filteredUrls.slice(0, 500).map((url, idx) => {
              let displayLoc = url.loc;
              let protocol = 'https';
              try {
                const urlObj = new URL(url.loc);
                displayLoc = url.loc.replace(urlObj.origin, '');
                protocol = urlObj.protocol.replace(':', '');
              } catch {}
              const isContent = isLikelyContentPage(url.loc);
              
              return (
                <tr 
                  key={idx} 
                  className="hover:bg-muted/30 transition-colors group"
                  data-testid={`url-row-${idx}`}
                >
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground font-bold uppercase opacity-40">
                          {protocol}
                        </span>
                        <span className={`text-sm font-semibold transition-colors ${isContent ? 'text-primary' : 'text-foreground'}`}>
                          {displayLoc || '/'}
                        </span>
                      </div>
                      {url.lastmod && (
                        <span className="text-[9px] font-medium text-muted-foreground flex items-center gap-1 bg-muted px-2 py-0.5 rounded w-fit">
                          <Clock className="h-3 w-3" /> 
                          {new Date(url.lastmod).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2">
                      <div className={`flex items-center gap-1 px-2 py-1 rounded border ${url.images.length > 0 ? 'bg-primary/10 border-primary/20 text-primary' : 'bg-muted border-border text-muted-foreground'}`}>
                        <ImageIcon className="h-3 w-3" />
                        <span className="text-[10px] font-bold">{url.images.length}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    {url.scrapedData ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPreviewEntry(url)}
                        className="gap-2 text-[10px] font-bold uppercase tracking-wider bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
                        data-testid={`view-content-${idx}`}
                      >
                        <CheckCircle className="h-3 w-3" />
                        {t('sequentialDataReady')}
                      </Button>
                    ) : (
                      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest italic">
                        {isContent ? t('pendingExtraction') : t('categoryPath')}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {url.scrapedData && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPreviewEntry(url)}
                          title="Reader View"
                          data-testid={`reader-view-${idx}`}
                        >
                          <ScanText className="h-4 w-4" />
                        </Button>
                      )}
                      <a 
                        href={url.loc} 
                        target="_blank" 
                        rel="noopener noreferrer"
                      >
                        <Button variant="ghost" size="icon" data-testid={`external-link-${idx}`}>
                          <ExternalLink className="h-4 w-4" />
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
          <div className="py-20 text-center">
            <FileCode className="h-12 w-12 text-muted-foreground/20 mx-auto mb-4" />
            <p className="text-muted-foreground font-medium">{t('noProjects')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
