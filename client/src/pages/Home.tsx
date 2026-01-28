import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { 
  Play, Square, Loader2, Download, Settings, 
  Trash2, ScanText, Globe, ArrowLeft, Plus, RefreshCw, Pause, X,
  Layers, Package, Cog
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';
import StatsCards from '@/components/StatsCards';
import UrlList from '@/components/UrlList';
import ErrorLogs from '@/components/ErrorLogs';
import ProjectCard from '@/components/ProjectCard';
import ProjectSettings from '@/components/ProjectSettings';
import ChunkingProgress from '@/components/ChunkingProgress';
import { useLanguage } from '@/hooks/use-language';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import type { Project, SitemapUrlEntry, ProjectSettings as ProjectSettingsType } from '@shared/schema';

const BATCH_SIZE = 10;

export default function Home() {
  const { language, setLanguage, t, isLoading: langLoading } = useLanguage();
  const { toast } = useToast();
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChunkingProgress, setShowChunkingProgress] = useState(false);
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
      setShowNewProject(false);
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
      updates: { status: 'idle', queue: [] },
    });
  }, [activeProject, updateProjectMutation]);

  const pauseProcess = useCallback(() => {
    if (!activeProject) return;
    const currentStatus = activeProject.status;
    if (currentStatus === 'content_scraping') {
      updateProjectMutation.mutate({
        id: activeProject.id,
        updates: { status: 'content_paused' },
      });
    } else if (currentStatus === 'scraping') {
      updateProjectMutation.mutate({
        id: activeProject.id,
        updates: { status: 'paused' },
      });
    }
  }, [activeProject, updateProjectMutation]);

  const resumeProcess = useCallback(() => {
    if (!activeProject) return;
    const currentStatus = activeProject.status;
    if (currentStatus === 'content_paused') {
      updateProjectMutation.mutate({
        id: activeProject.id,
        updates: { status: 'content_scraping' },
      });
    } else if (currentStatus === 'paused') {
      updateProjectMutation.mutate({
        id: activeProject.id,
        updates: { status: 'scraping' },
      });
    }
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
        
        if (file.name.endsWith('.xml')) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(content, 'text/xml');
          const parseError = doc.querySelector('parsererror');
          if (parseError) throw new Error('Invalid XML');
          
          const urls: SitemapUrlEntry[] = [];
          doc.querySelectorAll('url').forEach(el => {
            const loc = el.querySelector('loc')?.textContent?.trim();
            if (!loc) return;
            
            const images: { loc: string }[] = [];
            el.querySelectorAll('image').forEach(img => {
              const iLoc = img.querySelector('loc')?.textContent?.trim();
              if (iLoc) images.push({ loc: iLoc });
            });
            
            urls.push({
              loc,
              lastmod: el.querySelector('lastmod')?.textContent?.trim(),
              changefreq: el.querySelector('changefreq')?.textContent?.trim(),
              priority: el.querySelector('priority')?.textContent?.trim(),
              images,
              videos: [],
            });
          });
          
          let domain = 'Imported XML';
          if (urls.length > 0) {
            try {
              const firstUrl = new URL(urls[0].loc);
              domain = firstUrl.hostname;
            } catch {}
          }
          
          await apiRequest('POST', '/api/projects', {
            domain,
            displayName: `${domain} (${file.name})`,
            status: 'idle',
            queue: [],
            processed: [],
            results: urls,
            errors: [],
            stats: {
              totalSitemaps: 1,
              processedSitemaps: 1,
              totalUrls: urls.length,
              totalImages: urls.reduce((acc, u) => acc + u.images.length, 0),
              totalVideos: 0,
              startTime: Date.now(),
              endTime: Date.now(),
            },
          });
        } else {
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
        }
        
        queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
        toast({ title: t('success') });
      } catch (err) {
        console.error('Import error:', err);
        toast({ title: t('error'), description: t('importFailed'), variant: 'destructive' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const progressPercent = useMemo(() => {
    if (!activeProject) return 0;
    if (activeProject.status === 'scraping' || activeProject.status === 'paused') {
      const total = (activeProject.processed?.length || 0) + (activeProject.queue?.length || 0);
      return total === 0 ? 0 : Math.min(100, Math.round(((activeProject.processed?.length || 0) / total) * 100));
    }
    if (activeProject.status === 'content_scraping' || activeProject.status === 'content_paused') {
      const scraped = (activeProject.results || []).filter(r => r.scrapedData).length;
      const total = (activeProject.results || []).length;
      return total === 0 ? 0 : Math.min(100, Math.round((scraped / total) * 100));
    }
    return 0;
  }, [activeProject]);

  const isProcessing = activeProject?.status === 'scraping' || activeProject?.status === 'content_scraping';
  const isPaused = activeProject?.status === 'paused' || activeProject?.status === 'content_paused';
  const hasActiveProcess = isProcessing || isPaused;
  const remainingUrls = activeProject?.queue?.length || 0;
  const scrapedCount = (activeProject?.results || []).filter(r => r.scrapedData).length;
  const pendingContentScrape = (activeProject?.results || []).filter(r => !r.scrapedData).length;

  if (langLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <Loader2 className="w-10 h-10 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-background">
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleImport} 
        className="hidden" 
        accept=".json,.xml" 
      />
      
      <Sidebar 
        activeView={activeProjectId ? 'project' : 'dashboard'}
        onNavigate={() => setActiveProjectId(null)}
        onImport={() => fileInputRef.current?.click()}
        t={t}
      />
      
      <div className="flex-1 flex flex-col min-w-0">
        <Header 
          title={activeProject ? (activeProject.displayName || activeProject.domain) : 'Dashboard'}
          subtitle={activeProject ? `${activeProject.results?.length || 0} URLs` : undefined}
          language={language}
          onLanguageChange={setLanguage}
          t={t}
        />
        
        <main className="flex-1 overflow-auto p-6">
          {!activeProjectId ? (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-foreground">{t('recentProjects')}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {projects.length} {projects.length === 1 ? 'Projekt' : 'Projekte'}
                  </p>
                </div>
                <Button 
                  onClick={() => setShowNewProject(true)}
                  className="gap-2"
                  data-testid="new-project-button"
                >
                  <Plus className="w-4 h-4" />
                  {t('newProject')}
                </Button>
              </div>

              {showNewProject && (
                <div className="bg-card border border-border rounded-xl p-6">
                  <h3 className="text-sm font-medium text-foreground mb-4">{t('newProject')}</h3>
                  <div className="flex gap-3">
                    <Input
                      type="text"
                      className="flex-1 bg-input"
                      placeholder={t('enterDomain')}
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && domainInput && createProjectMutation.mutate(domainInput)}
                      data-testid="domain-input"
                    />
                    <Button
                      onClick={() => createProjectMutation.mutate(domainInput)}
                      disabled={!domainInput || isCreating}
                      className="gap-2"
                      data-testid="scrape-button"
                    >
                      {isCreating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                      {t('scrape')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setShowNewProject(false)}
                    >
                      {t('cancel')}
                    </Button>
                  </div>
                </div>
              )}

              {projects.length === 0 ? (
                <div className="bg-card border border-dashed border-border rounded-xl py-16 text-center">
                  <Globe className="w-10 h-10 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground">{t('noProjects')}</p>
                  <Button 
                    variant="outline" 
                    className="mt-4 gap-2"
                    onClick={() => setShowNewProject(true)}
                  >
                    <Plus className="w-4 h-4" />
                    {t('newProject')}
                  </Button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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
          ) : (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <Button
                  variant="ghost"
                  onClick={() => setActiveProjectId(null)}
                  className="gap-2 -ml-2"
                  data-testid="back-button"
                >
                  <ArrowLeft className="w-4 h-4" />
                  {t('recentProjects')}
                </Button>
                
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-2" data-testid="actions-menu">
                        <Settings className="w-4 h-4" />
                        {t('actionsMenu')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem onClick={startContentScrape} className="gap-2">
                        <ScanText className="w-4 h-4" />
                        {t('scrapeAllContent')}
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => {
                          const scrapedCount = activeProject?.results?.filter(r => r.scrapedData).length || 0;
                          if (scrapedCount === 0) {
                            toast({ title: t('deepScrapingRequired'), variant: 'destructive' });
                            return;
                          }
                          setShowChunkingProgress(true);
                        }}
                        className={`gap-2 ${(activeProject?.results?.filter(r => r.scrapedData).length || 0) === 0 ? 'opacity-50' : ''}`}
                        disabled={(activeProject?.results?.filter(r => r.scrapedData).length || 0) === 0}
                      >
                        <Layers className="w-4 h-4" />
                        {t('generateChunks')}
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => {
                          if ((activeProject?.chunks?.length || 0) === 0) {
                            toast({ title: t('noChunksYet'), variant: 'destructive' });
                            return;
                          }
                          toast({ title: t('exportRagPack'), description: 'Export wird vorbereitet...' });
                          window.open(`/api/projects/${activeProject!.id}/rag-pack`, '_blank');
                        }}
                        className={`gap-2 ${(activeProject?.chunks?.length || 0) === 0 ? 'opacity-50' : ''}`}
                        disabled={(activeProject?.chunks?.length || 0) === 0}
                      >
                        <Package className="w-4 h-4" />
                        {t('exportRagPack')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={() => {
                          if (confirm(t('wipeConfirm'))) {
                            updateProjectMutation.mutate({
                              id: activeProject!.id,
                              updates: { 
                                results: [], 
                                chunks: [],
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
                        className="gap-2 text-destructive focus:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                        {t('clearAllProgress')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setShowSettings(true)} 
                    className="gap-2" 
                    data-testid="settings-button"
                  >
                    <Cog className="w-4 h-4" />
                    {t('settings')}
                  </Button>

                  <Button variant="outline" size="sm" onClick={exportProject} className="gap-2" data-testid="export-button">
                    <Download className="w-4 h-4" />
                    {t('exportJson')}
                  </Button>

                  {activeProject?.status === 'idle' && (
                    <Button 
                      size="sm"
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
                      <RefreshCw className="w-4 h-4" />
                      {t('fullResync')}
                    </Button>
                  )}
                </div>
              </div>

              {hasActiveProcess && (
                <div className={`border rounded-xl p-4 ${isPaused ? 'bg-muted border-border' : 'bg-primary/10 border-primary/20'}`}>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 shrink-0">
                      {isPaused ? (
                        <>
                          <Button
                            size="icon"
                            onClick={resumeProcess}
                            data-testid="resume-button"
                          >
                            <Play className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="destructive"
                            onClick={stopProcess}
                            data-testid="cancel-button"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin text-primary" />
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={pauseProcess}
                            data-testid="pause-button"
                          >
                            <Pause className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="destructive"
                            onClick={stopProcess}
                            data-testid="stop-process-button"
                          >
                            <Square className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {(activeProject?.status === 'scraping' || activeProject?.status === 'paused') 
                              ? t('parallelAnalysis') 
                              : t('deepExtraction')}
                          </p>
                          {isPaused && (
                            <Badge variant="secondary" className="text-[10px]">{t('paused')}</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span>{t('remainingPages')}: {remainingUrls}</span>
                          <span>{progressPercent}%</span>
                        </div>
                      </div>
                      <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all duration-500 ${isPaused ? 'bg-muted-foreground' : 'bg-primary'}`}
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {!hasActiveProcess && activeProject?.status === 'idle' && pendingContentScrape > 0 && (
                <div className="bg-card border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-foreground">{t('deepExtraction')}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {pendingContentScrape} {t('pending')} | {scrapedCount} {t('sequentialDataReady')}
                      </p>
                    </div>
                    <Button onClick={startContentScrape} className="gap-2" data-testid="start-extraction-button">
                      <Play className="w-4 h-4" />
                      {t('startExtraction')}
                    </Button>
                  </div>
                </div>
              )}

              <StatsCards 
                stats={activeProject?.stats || null} 
                urlCount={activeProject?.results?.length || 0}
                scrapedCount={activeProject?.results?.filter(r => r.scrapedData).length || 0}
                t={t} 
              />

              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <Tabs defaultValue="urls" className="flex flex-col">
                  <TabsList className="w-full justify-start border-b border-border rounded-none bg-transparent p-0">
                    <TabsTrigger 
                      value="urls" 
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
                      data-testid="tab-urls"
                    >
                      {t('analyzedPages')} ({activeProject?.results?.length || 0})
                    </TabsTrigger>
                    <TabsTrigger 
                      value="errors" 
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
                      data-testid="tab-errors"
                    >
                      {t('crawlFailures')} ({activeProject?.errors?.length || 0})
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="urls" className="m-0 min-h-[400px]">
                    <UrlList urls={activeProject?.results || []} t={t} />
                  </TabsContent>
                  <TabsContent value="errors" className="m-0 min-h-[400px]">
                    <ErrorLogs errors={activeProject?.errors || []} t={t} />
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          )}
        </main>
      </div>

      {showSettings && activeProject && (
        <ProjectSettings
          settings={activeProject.projectSettings}
          onSave={(newSettings) => {
            updateProjectMutation.mutate({
              id: activeProject.id,
              updates: { projectSettings: newSettings },
            });
          }}
          onClose={() => setShowSettings(false)}
          t={t}
        />
      )}

      {showChunkingProgress && activeProject && (
        <ChunkingProgress
          open={showChunkingProgress}
          onClose={() => setShowChunkingProgress(false)}
          projectId={activeProject.id}
          totalPages={activeProject.results?.filter(r => r.scrapedData).length || 0}
          onComplete={(result) => {
            queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
            toast({ 
              title: t('success'), 
              description: `${result.chunksGenerated} ${t('chunksGenerated')}` 
            });
          }}
          t={t}
        />
      )}
    </div>
  );
}
