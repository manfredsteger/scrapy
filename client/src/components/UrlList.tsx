import { useState } from 'react';
import { ExternalLink, CheckCircle, Clock, Search, Eye, ChevronDown, Loader2, XCircle, AlertCircle, RotateCcw, FileDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import ContentPreview from './ContentPreview';
import { apiRequest } from '@/lib/queryClient';
import type { SitemapUrlEntry, RagChunk } from '@shared/schema';

const PAGE_SIZE_OPTIONS = [100, 500, 1000, 5000, 25000, 100000];

interface UrlListProps {
  urls: SitemapUrlEntry[];
  totalCount: number;
  projectId: number;
  t: (key: any) => string;
  chunks?: RagChunk[];
  onRescrapeUrl?: (url: string) => void;
  isLoading?: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  activeFolder: string | null;
  onFolderChange: (folder: string | null) => void;
  folderStats: Array<[string, number]>;
}

export default function UrlList({
  urls,
  totalCount,
  projectId,
  t,
  chunks = [],
  onRescrapeUrl,
  isLoading = false,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  search,
  onSearchChange,
  activeFolder,
  onFolderChange,
  folderStats,
}: UrlListProps) {
  const [previewEntry, setPreviewEntry] = useState<SitemapUrlEntry | null>(null);
  const [showFolders, setShowFolders] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
  const [contentCache, setContentCache] = useState<Map<string, SitemapUrlEntry>>(new Map());
  const [rescrapingUrl, setRescrapingUrl] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  const handleRescrape = async (url: string) => {
    if (rescrapingUrl) return;
    
    setRescrapingUrl(url);
    try {
      const res = await apiRequest('POST', '/api/scrape/content', {
        urls: [url],
        projectId: projectId,
      });
      const data = await res.json();
      
      if (data.results?.[0]?.success) {
        setContentCache(prev => {
          const newCache = new Map(prev);
          newCache.delete(url);
          return newCache;
        });
        
        if (onRescrapeUrl) {
          onRescrapeUrl(url);
        }
      }
    } catch (error) {
      console.error('Failed to rescrape URL:', error);
    } finally {
      setRescrapingUrl(null);
    }
  };

  const handlePreviewClick = async (url: SitemapUrlEntry) => {
    if (url.scrapedData) {
      setPreviewEntry(url);
      return;
    }
    
    // Check cache first
    if (contentCache.has(url.loc)) {
      setPreviewEntry(contentCache.get(url.loc)!);
      return;
    }
    
    try {
      setLoadingPreview(url.loc);
      const res = await apiRequest('GET', `/api/projects/${projectId}/url-content?loc=${encodeURIComponent(url.loc)}`);
      const fullEntry = await res.json();
      // Cache the result
      setContentCache(prev => new Map(prev).set(url.loc, fullEntry));
      setPreviewEntry(fullEntry);
    } catch (error) {
      console.error('Failed to load content preview:', error);
    } finally {
      setLoadingPreview(null);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {previewEntry && previewEntry.scrapedData && (
        <ContentPreview 
          entry={previewEntry} 
          onClose={() => setPreviewEntry(null)} 
          t={t}
          chunks={chunks}
          projectId={projectId}
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
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
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
              onClick={() => onFolderChange(null)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                !activeFolder 
                  ? 'bg-primary text-primary-foreground' 
                  : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
              data-testid="filter-all"
            >
              Alle ({totalCount.toLocaleString()})
            </button>
            {folderStats.slice(0, 12).map(([folder, count]) => (
              <button
                key={folder}
                onClick={() => onFolderChange(activeFolder === folder ? null : folder)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  activeFolder === folder 
                    ? 'bg-primary text-primary-foreground' 
                    : 'bg-secondary text-secondary-foreground hover:bg-accent'
                }`}
                data-testid={`filter-${folder}`}
              >
                {folder} ({count.toLocaleString()})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto relative">
        {isLoading && (
          <div className="absolute inset-0 bg-card/60 backdrop-blur-[1px] z-20 flex items-start justify-center pt-16">
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-card border border-border rounded-lg px-4 py-2 shadow-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('loading')}
            </div>
          </div>
        )}
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
            {urls.map((url, idx) => {
              let displayPath = url.loc;
              try {
                const parsedUrl = new URL(url.loc);
                const pathname = parsedUrl.pathname || '/';
                const hash = parsedUrl.hash || '';
                
                // For Moodle course sections, use the title or extract section name
                const isMoodleSection = pathname.includes('/course/view.php') && hash.includes('#section-');
                const pageTitle = url.scrapedData?.title;
                
                if (isMoodleSection && pageTitle) {
                  // Extract chapter name from title (format: "Kursname - Kapitelname")
                  const parts = pageTitle.split(' - ');
                  displayPath = parts.length > 1 ? parts.slice(-1)[0] : pageTitle;
                } else if (pageTitle && pathname === '/course/view.php') {
                  // For Moodle pages without section, use title
                  displayPath = pageTitle;
                } else {
                  displayPath = pathname + hash;
                }
              } catch {}
              
              // Truncate long paths for display
              const maxLength = 50;
              const truncatedPath = displayPath.length > maxLength 
                ? displayPath.slice(0, maxLength) + '...' 
                : displayPath;
              const needsTruncation = displayPath.length > maxLength;
              
              return (
                <tr key={url.loc || idx} data-testid={`url-row-${idx}`}>
                  <td className="overflow-hidden">
                    <div className="flex items-center gap-2 min-w-0">
                      {needsTruncation ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button 
                              className={`text-sm font-medium truncate block max-w-full text-left ${
                                (url.scrapedData || url.hasScrapedData) 
                                  ? 'text-foreground hover:text-primary cursor-pointer hover:underline' 
                                  : 'text-foreground cursor-help'
                              }`}
                              onClick={() => (url.scrapedData || url.hasScrapedData) && handlePreviewClick(url)}
                              data-testid={`text-url-truncated-${idx}`}
                            >
                              {truncatedPath}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-md break-all" data-testid={`text-url-full-${idx}`}>
                            <p className="text-xs">{displayPath}</p>
                            <p className="text-[10px] text-muted-foreground mt-1">{url.loc}</p>
                            {(url.scrapedData || url.hasScrapedData) && (
                              <p className="text-[10px] text-primary mt-1">Klicken für Vorschau</p>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <button 
                          className={`text-sm font-medium truncate block max-w-full text-left ${
                            (url.scrapedData || url.hasScrapedData) 
                              ? 'text-foreground hover:text-primary cursor-pointer hover:underline' 
                              : 'text-foreground cursor-default'
                          }`}
                          onClick={() => (url.scrapedData || url.hasScrapedData) && handlePreviewClick(url)}
                          title={(url.scrapedData || url.hasScrapedData) ? 'Klicken für Vorschau' : url.loc}
                          data-testid={`text-url-${idx}`}
                        >
                          {displayPath}
                        </button>
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
                    {url.scrapedData || url.hasScrapedData ? (
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className="badge-green whitespace-nowrap">
                          <CheckCircle className="w-3 h-3 shrink-0" />
                          Scraped
                        </span>
                        {((url as any).pdfCount > 0 || (url.scrapedData as any)?.linkedPdfs?.length > 0) && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-500 border border-red-500/30 whitespace-nowrap" data-testid={`badge-pdf-${(url as any).pdfCount || (url.scrapedData as any)?.linkedPdfs?.length}`}>
                            <FileDown className="w-3 h-3 shrink-0" />
                            {(url as any).pdfCount || (url.scrapedData as any)?.linkedPdfs?.length} PDF
                          </span>
                        )}
                      </div>
                    ) : (url as any).errorStatus === 'soft-404' ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-500/10 text-orange-500 border border-orange-500/30 whitespace-nowrap cursor-help" data-testid="badge-soft-404">
                            <AlertCircle className="w-3 h-3 shrink-0" />
                            Soft-404
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs">{(url as any).errorMessage || 'Seite antwortet mit HTTP 200, enthält aber eine Fehlerseite ("nicht gefunden") statt Inhalt.'}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (url as any).errorStatus === 'failed' ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/10 text-red-500 border border-red-500/30 whitespace-nowrap cursor-help">
                            <XCircle className="w-3 h-3 shrink-0" />
                            Failed
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs">{(url as any).errorMessage || 'Unknown error'}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (url as any).errorStatus === 'skipped' ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-500 border border-yellow-500/30 whitespace-nowrap cursor-help">
                            <AlertCircle className="w-3 h-3 shrink-0" />
                            Skipped
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs">{(url as any).errorMessage || 'Non-HTML content'}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="badge-gray whitespace-nowrap">Pending</span>
                    )}
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRescrape(url.loc)}
                            disabled={rescrapingUrl === url.loc}
                            data-testid={`rescrape-${idx}`}
                          >
                            {rescrapingUrl === url.loc ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RotateCcw className="w-4 h-4" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Neu scrapen</p>
                        </TooltipContent>
                      </Tooltip>
                      {(url.scrapedData || url.hasScrapedData) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handlePreviewClick(url)}
                              disabled={loadingPreview === url.loc}
                              data-testid={`view-content-${idx}`}
                            >
                              {loadingPreview === url.loc ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Vorschau</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a href={url.loc} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" data-testid={`external-link-${idx}`}>
                              <ExternalLink className="w-4 h-4" />
                            </Button>
                          </a>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Öffnen</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        
        {!isLoading && urls.length === 0 && (
          <div className="py-16 text-center">
            <p className="text-muted-foreground">{t('noProjects')}</p>
          </div>
        )}
      </div>

      {totalCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-t border-border bg-card text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span data-testid="text-results-range">
              {(page * pageSize + 1).toLocaleString()}–{Math.min((page + 1) * pageSize, totalCount).toLocaleString()} von {totalCount.toLocaleString()}
            </span>
            <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
              <SelectTrigger className="h-8 w-[110px]" data-testid="select-page-size">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map(size => (
                  <SelectItem key={size} value={String(size)}>{size.toLocaleString()} / Seite</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(Math.max(0, page - 1))}
              disabled={page === 0}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid="text-page-indicator">
              Seite {page + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              data-testid="button-next-page"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
