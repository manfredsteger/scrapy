import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { 
  Plus, Play, Square, Loader2, Upload, Download, Settings, 
  Trash2, ScanText, Database, Layers, Globe, CheckCircle2, ArrowLeft 
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Header from '@/components/Header';
import StatsCards from '@/components/StatsCards';
import UrlList from '@/components/UrlList';
import ErrorLogs from '@/components/ErrorLogs';
import ProjectCard from '@/components/ProjectCard';
import { useLanguage } from '@/hooks/use-language';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import type { Project, SitemapUrlEntry, ScrapingError } from '@shared/schema';

const BATCH_SIZE = 10;

export default function Home() {
  const { language, setLanguage, t, isLoading: langLoading } = useLanguage();
  const { toast } = useToast();
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['/api/projects'],
  });

  const activeProject = useMemo(() => 
    projects.find(p => p.id === activeProjectId), 
    [projects, activeProjectId]
  );

  const createProjectMutation = useMutation({
    mutationFn: async (domain: string) => {
      setIsCreating(true);
      const discoverRes = await apiRequest('POST', '/api/scrape/discover', { domain });
      const { sitemaps } = await discoverRes.json();
      
      const project = await apiRequest('POST', '/api/projects', {
        domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        displayName: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        status: 'scraping',
        queue: sitemaps,
        processed: [],
        results: [],
        errors: [],
        stats: {
          totalSitemaps: sitemaps.length,
          processedSitemaps: 0,
          totalUrls: 0,
          totalImages: 0,
          totalVideos: 0,
          startTime: Date.now(),
        },
      });
      return project.json();
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      setActiveProjectId(project.id);
      setDomainInput('');
      setIsCreating(false);
    },
    onError: () => {
      toast({ title: t('error'), description: t('initError'), variant: 'destructive' });
      setIsCreating(false);
    },
  });

  const updateProjectMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Partial<Project> }) => {
      const res = await apiRequest('PUT', `/api/projects/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest('DELETE', `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      if (activeProjectId) setActiveProjectId(null);
    },
  });

  const processStep = useCallback(async () => {
    if (processingRef.current) return;
    
    const scrapingProject = projects.find(p => p.status === 'scraping');
    if (scrapingProject) {
      if (scrapingProject.queue.length === 0) {
        await updateProjectMutation.mutateAsync({ 
          id: scrapingProject.id, 
          updates: { 
            status: 'idle',
            stats: { ...scrapingProject.stats!, endTime: Date.now() }
          } 
        });
        return;
      }

      processingRef.current = true;
      const batchUrls = scrapingProject.queue.slice(0, BATCH_SIZE);
      const remainingQueue = scrapingProject.queue.slice(BATCH_SIZE);
      
      try {
        const results = await Promise.all(batchUrls.map(async (url) => {
          try {
            const res = await apiRequest('POST', '/api/scrape/sitemap', { url });
            return { url, data: await res.json(), error: null };
          } catch (err) {
            return { url, data: null, error: (err as Error).message };
          }
        }));

        let newResults = [...(scrapingProject.results || [])];
        let newQueue = [...remainingQueue];
        let newProcessed = [...(scrapingProject.processed || []), ...batchUrls];
        let newErrors = [...(scrapingProject.errors || [])];
        let sitemapsProcessed = 0;
        let newSitemapsFound = 0;

        results.forEach(res => {
          sitemapsProcessed++;
          if (res.data) {
            const { urls, subSitemaps } = res.data;
            const existingLocs = new Set(newResults.map(r => r.loc));
            const uniqueNewUrls = urls.filter((u: SitemapUrlEntry) => !existingLocs.has(u.loc));
            newResults = [...newResults, ...uniqueNewUrls];
            const filteredSub = subSitemaps.filter((s: string) => 
              !newProcessed.includes(s) && !newQueue.includes(s)
            );
            newQueue = [...newQueue, ...filteredSub];
            newSitemapsFound += filteredSub.length;
          } else if (res.error) {
            newErrors.push({ 
              url: res.url, 
              message: res.error, 
              timestamp: new Date().toISOString() 
            });
          }
        });

        await updateProjectMutation.mutateAsync({
          id: scrapingProject.id,
          updates: {
            queue: newQueue,
            processed: newProcessed,
            results: newResults,
            errors: newErrors,
            stats: {
              ...scrapingProject.stats!,
              processedSitemaps: (scrapingProject.stats?.processedSitemaps || 0) + sitemapsProcessed,
              totalSitemaps: (scrapingProject.stats?.totalSitemaps || 0) + newSitemapsFound,
              totalUrls: newResults.length,
              totalImages: newResults.reduce((acc, curr) => acc + (curr.images?.length || 0), 0),
            },
          },
        });
      } finally {
        processingRef.current = false;
      }
      return;
    }

    const contentScrapingProject = projects.find(p => p.status === 'content_scraping');
    if (contentScrapingProject) {
      if (contentScrapingProject.queue.length === 0) {
        await updateProjectMutation.mutateAsync({ 
          id: contentScrapingProject.id, 
          updates: { 
            status: 'idle',
            stats: { ...contentScrapingProject.stats!, endTime: Date.now() }
          } 
        });
        return;
      }

      processingRef.current = true;
      const batchUrls = contentScrapingProject.queue.slice(0, BATCH_SIZE);
      const remainingQueue = contentScrapingProject.queue.slice(BATCH_SIZE);

      try {
        const res = await apiRequest('POST', '/api/scrape/content', { urls: batchUrls });
        const { results } = await res.json();

        let newResults = [...(contentScrapingProject.results || [])];
        let newErrors = [...(contentScrapingProject.errors || [])];
        let scrapedInBatch = 0;

        results.forEach((r: { url: string; data: any; error: string | null }) => {
          if (r.data) {
            newResults = newResults.map(existing => 
              existing.loc === r.url ? { ...existing, scrapedData: r.data } : existing
            );
            scrapedInBatch++;
          } else if (r.error) {
            newErrors.push({ 
              url: r.url, 
              message: "Extract Error: " + r.error, 
              timestamp: new Date().toISOString() 
            });
          }
        });

        await updateProjectMutation.mutateAsync({
          id: contentScrapingProject.id,
          updates: {
            queue: remainingQueue,
            results: newResults,
            errors: newErrors,
            stats: {
              ...contentScrapingProject.stats!,
              scrapedPages: (contentScrapingProject.stats?.scrapedPages || 0) + scrapedInBatch,
            },
          },
        });
      } finally {
        processingRef.current = false;
      }
    }
  }, [projects, updateProjectMutation]);

  useEffect(() => {
    const active = projects.find(p => p.status === 'scraping' || p.status === 'content_scraping');
    if (active && !processingRef.current) {
      const timer = setTimeout(processStep, active.status === 'scraping' ? 500 : 1000);
      return () => clearTimeout(timer);
    }
  }, [projects, processStep]);

  const startContentScrape = useCallback(() => {
    if (!activeProject) return;
    
    const contentUrls = (activeProject.results || [])
      .filter(r => !r.scrapedData)
      .map(r => r.loc);

    if (contentUrls.length === 0) {
      toast({ title: t('error'), description: t('noContentPages'), variant: 'destructive' });
      return;
    }

    updateProjectMutation.mutate({
      id: activeProject.id,
      updates: { status: 'content_scraping', queue: contentUrls },
    });
  }, [activeProject, updateProjectMutation, toast, t]);

  const stopProcess = useCallback(() => {
    if (!activeProject) return;
    updateProjectMutation.mutate({
      id: activeProject.id,
      updates: { status: 'idle' },
    });
  }, [activeProject, updateProjectMutation]);

  const exportProject = useCallback(() => {
    if (!activeProject) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(activeProject, null, 2));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = `${(activeProject.displayName || activeProject.domain).replace(/[^a-z0-9]/gi, '_')}-export.json`;
    a.click();
  }, [activeProject]);

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const content = event.target?.result as string;
        const imported = JSON.parse(content);
        await apiRequest('POST', '/api/projects', {
          domain: imported.domain,
          displayName: imported.displayName || imported.domain,
          status: 'idle',
          queue: imported.queue || [],
          processed: imported.processed || [],
          results: imported.results || [],
          errors: imported.errors || [],
          stats: imported.stats,
        });
        queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
        toast({ title: t('success') });
      } catch {
        toast({ title: t('error'), description: t('importFailed'), variant: 'destructive' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const progressPercent = useMemo(() => {
    if (!activeProject) return 0;
    if (activeProject.status === 'scraping') {
      const total = (activeProject.processed?.length || 0) + (activeProject.queue?.length || 0);
      return total === 0 ? 0 : Math.min(100, Math.round(((activeProject.processed?.length || 0) / total) * 100));
    }
    if (activeProject.status === 'content_scraping') {
      const scraped = (activeProject.results || []).filter(r => r.scrapedData).length;
      const total = (activeProject.results || []).length;
      return total === 0 ? 0 : Math.min(100, Math.round((scraped / total) * 100));
    }
    return 0;
  }, [activeProject]);

  if (langLoading || isLoading) {
    return (
      <div className="min-h-screen flex flex-col bg-background text-foreground">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin mx-auto mb-4 text-primary" />
            <p className="font-bold text-muted-foreground uppercase tracking-widest text-xs">
              {t('databaseSync')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <Header 
        onLogoClick={() => setActiveProjectId(null)}
        language={language}
        onLanguageChange={setLanguage}
        t={t}
      />
      
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8">
        {!activeProjectId ? (
          <div className="space-y-10">
            <Card className="p-8 text-center max-w-3xl mx-auto">
              <div className="inline-flex p-4 rounded-2xl bg-primary text-primary-foreground mb-6">
                <Database className="h-10 w-10" />
              </div>
              <h2 className="text-2xl font-bold text-foreground mb-2 tracking-tight">
                {t('enterpriseCrawler')}
              </h2>
              <p className="text-muted-foreground mb-8">
                {t('crawlerDescription')}
              </p>
              
              <div className="flex flex-col md:flex-row gap-3 items-center">
                <Input
                  type="text"
                  className="flex-1"
                  placeholder={t('enterDomain')}
                  value={domainInput}
                  onChange={(e) => setDomainInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && domainInput && createProjectMutation.mutate(domainInput)}
                  data-testid="domain-input"
                />
                <div className="flex gap-2 w-full md:w-auto">
                  <Button
                    onClick={() => createProjectMutation.mutate(domainInput)}
                    disabled={!domainInput || isCreating}
                    className="flex-1 md:flex-none gap-2"
                    data-testid="scrape-button"
                  >
                    {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {t('scrape')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    className="gap-2"
                    data-testid="import-button"
                  >
                    <Upload className="h-4 w-4" />
                    {t('import')}
                  </Button>
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleImport} 
                    className="hidden" 
                    accept=".json,.xml" 
                  />
                </div>
              </div>
            </Card>

            <div className="space-y-4">
              <h3 className="text-lg font-bold text-foreground flex items-center gap-3 px-2">
                <Layers className="h-5 w-5 text-primary" />
                {t('recentProjects')}
              </h3>

              {projects.length === 0 ? (
                <Card className="border-dashed py-16 text-center">
                  <p className="text-muted-foreground font-medium">{t('noProjects')}</p>
                </Card>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {projects.map(project => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onSelect={() => setActiveProjectId(project.id)}
                      onDelete={() => {
                        if (confirm(t('deleteConfirm'))) {
                          deleteProjectMutation.mutate(project.id);
                        }
                      }}
                      onRename={(newName) => {
                        updateProjectMutation.mutate({
                          id: project.id,
                          updates: { displayName: newName },
                        });
                      }}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <Button
                variant="ghost"
                onClick={() => setActiveProjectId(null)}
                className="gap-2 w-fit"
                data-testid="back-button"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('recentProjects')}
              </Button>
              
              <div className="flex items-center gap-3">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="gap-2" data-testid="actions-menu">
                      <Settings className="h-4 w-4" />
                      {t('actionsMenu')}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onClick={startContentScrape} className="gap-2">
                      <ScanText className="h-4 w-4" />
                      {t('scrapeAllContent')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem 
                      onClick={() => {
                        if (confirm(t('wipeConfirm'))) {
                          updateProjectMutation.mutate({
                            id: activeProject!.id,
                            updates: { 
                              results: [], 
                              stats: { 
                                ...activeProject!.stats!, 
                                totalUrls: 0, 
                                totalImages: 0, 
                                scrapedPages: 0 
                              } 
                            },
                          });
                        }
                      }}
                      className="gap-2 text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('clearAllProgress')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <Button variant="outline" onClick={exportProject} className="gap-2" data-testid="export-button">
                  <Download className="h-4 w-4" />
                  {t('exportJson')}
                </Button>

                {activeProject?.status !== 'idle' ? (
                  <Button onClick={stopProcess} variant="secondary" className="gap-2" data-testid="stop-button">
                    <Square className="h-4 w-4 fill-current" />
                    {t('stopProcess')}
                  </Button>
                ) : (
                  <Button 
                    onClick={() => {
                      updateProjectMutation.mutate({
                        id: activeProject!.id,
                        updates: { 
                          status: 'scraping', 
                          processed: [],
                          queue: activeProject?.queue || [],
                          stats: { ...activeProject!.stats!, startTime: Date.now() }
                        },
                      });
                    }}
                    className="gap-2"
                    data-testid="resync-button"
                  >
                    <Play className="h-4 w-4 fill-current" />
                    {t('fullResync')}
                  </Button>
                )}
              </div>
            </div>

            <Card className="p-6">
              <div className="flex items-center gap-4 mb-6">
                <div className="bg-primary/10 p-4 rounded-2xl text-primary border border-primary/20">
                  <Globe className="h-8 w-8" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-xl font-bold text-foreground tracking-tight truncate">
                    {activeProject?.displayName || activeProject?.domain}
                  </h2>
                  <p className="text-sm text-muted-foreground font-medium flex items-center gap-2 mt-1">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    {t('persistentEntry')} • {activeProject?.results?.length || 0} {t('foundLinks')}
                  </p>
                </div>
              </div>

              {activeProject?.status !== 'idle' && (
                <div className="bg-primary rounded-xl p-6 mb-6 text-primary-foreground">
                  <div className="flex items-center gap-4 mb-3">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <div className="flex-1">
                      <div className="flex justify-between items-end mb-2">
                        <p className="text-xs font-bold uppercase opacity-70">
                          {activeProject.status === 'scraping' ? t('parallelAnalysis') : t('deepExtraction')} ({progressPercent}%)
                        </p>
                        <p className="text-[10px] font-bold uppercase opacity-70">
                          {activeProject.processed?.length || 0} {t('items')}
                        </p>
                      </div>
                      <div className="w-full bg-primary-foreground/20 h-2 rounded-full overflow-hidden">
                        <div 
                          className="bg-primary-foreground h-full transition-all duration-500" 
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="bg-primary-foreground/10 px-3 py-2 rounded-lg text-xs font-medium truncate">
                    {t('activeBatch')}: {activeProject.queue?.slice(0, 5).join(', ')}
                  </div>
                </div>
              )}

              <StatsCards stats={activeProject?.stats || null} t={t} />
            </Card>

            <Card className="overflow-hidden min-h-[500px]">
              <Tabs defaultValue="urls" className="flex flex-col h-full">
                <TabsList className="w-full justify-start border-b border-border rounded-none bg-muted/50 p-1">
                  <TabsTrigger value="urls" className="flex-1" data-testid="tab-urls">
                    {t('analyzedPages')} ({activeProject?.results?.length || 0})
                  </TabsTrigger>
                  <TabsTrigger value="errors" className="flex-1" data-testid="tab-errors">
                    {t('crawlFailures')} ({activeProject?.errors?.length || 0})
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="urls" className="flex-1 m-0">
                  <UrlList urls={activeProject?.results || []} t={t} />
                </TabsContent>
                <TabsContent value="errors" className="flex-1 m-0">
                  <ErrorLogs errors={activeProject?.errors || []} t={t} />
                </TabsContent>
              </Tabs>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
