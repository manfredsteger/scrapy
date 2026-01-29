import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { 
  Play, Square, Loader2, Download, Settings, 
  Trash2, ScanText, Globe, ArrowLeft, Plus, RefreshCw, Pause, X,
  Layers, Package, Cog, FileText
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
import ConfirmDialog from '@/components/ConfirmDialog';
import { useLanguage } from '@/hooks/use-language';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import type { Project, SitemapUrlEntry, ProjectSettings as ProjectSettingsType, SinglePage } from '@shared/schema';

const BATCH_SIZE = 10;

export default function Home() {
  const [, navigate] = useLocation();
  const { language, setLanguage, t, isLoading: langLoading } = useLanguage();
  const { toast } = useToast();
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showChunkingProgress, setShowChunkingProgress] = useState(false);
  const [singleUrlInput, setSingleUrlInput] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; projectId: number | null; projectName: string }>({
    open: false,
    projectId: null,
    projectName: '',
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['/api/projects'],
  });

  const { data: singlePages = [], isLoading: singlePagesLoading } = useQuery<SinglePage[]>({
    queryKey: ['/api/single-pages'],
  });

  const createSinglePageMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest('POST', '/api/single-pages', { url });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/single-pages'] });
      setSingleUrlInput('');
    },
    onError: () => {
      toast({ title: t('error'), description: t('initError'), variant: 'destructive' });
    },
  });

  const deleteSinglePageMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest('DELETE', `/api/single-pages/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/single-pages'] });
    },
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
      
      // If no sitemaps found, crawl the base URL to discover internal links
      let initialQueue = sitemaps;
      let useCrawlMode = false;
      
      if (sitemaps.length === 0) {
        // No sitemaps found - use crawl mode starting from base URL
        let baseUrl = domain.trim();
        if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
        baseUrl = baseUrl.replace(/\/$/, '');
        initialQueue = [baseUrl]; // Start with the base URL
        useCrawlMode = true;
      }
      
      const project = await apiRequest('POST', '/api/projects', {
        domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        displayName: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        status: useCrawlMode ? 'crawling' : 'scraping',
        queue: initialQueue,
        processed: [],
        results: [],
        errors: [],
        stats: {
          totalSitemaps: sitemaps.length,
          processedSitemaps: 0,
          totalUrls: useCrawlMode ? 1 : 0,
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
      
      // Show info toast if crawl mode was used
      if (project.status === 'crawling') {
        toast({ 
          title: t('noSitemapFound'), 
          description: t('crawlModeActive'),
        });
      }
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

  const resyncProjectMutation = useMutation({
    mutationFn: async (project: Project) => {
      // Re-discover sitemaps/URLs for the project
      let domain = project.domain;
      if (!domain.startsWith('http')) domain = `https://${domain}`;
      
      const discoverRes = await apiRequest('POST', '/api/scrape/discover', { domain });
      const { sitemaps } = await discoverRes.json();
      
      // If no sitemaps found, use crawl mode
      let initialQueue = sitemaps;
      let useCrawlMode = false;
      
      if (sitemaps.length === 0) {
        let baseUrl = domain.trim();
        if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
        baseUrl = baseUrl.replace(/\/$/, '');
        initialQueue = [baseUrl];
        useCrawlMode = true;
      }
      
      // Update project with new queue and reset stats
      const res = await apiRequest('PUT', `/api/projects/${project.id}`, {
        status: useCrawlMode ? 'crawling' : 'scraping',
        queue: initialQueue,
        processed: [],
        results: [],
        errors: [],
        stats: {
          totalSitemaps: sitemaps.length,
          processedSitemaps: 0,
          totalUrls: useCrawlMode ? 1 : 0,
          totalImages: 0,
          totalVideos: 0,
          startTime: Date.now(),
        },
      });
      return { project: await res.json(), useCrawlMode };
    },
    onSuccess: ({ useCrawlMode }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      
      if (useCrawlMode) {
        toast({ 
          title: t('noSitemapFound'), 
          description: t('crawlModeActive'),
        });
      } else {
        toast({ 
          title: t('success'), 
          description: t('resyncStarted') || 'Synchronisation gestartet',
        });
      }
    },
    onError: () => {
      toast({ title: t('error'), description: t('initError'), variant: 'destructive' });
    },
  });

  const processStep = useCallback(async () => {
    if (processingRef.current) return;
    
    const scrapingProject = projects.find(p => p.status === 'scraping');
    if (scrapingProject) {
      if (!scrapingProject.queue || scrapingProject.queue.length === 0) {
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
      const batchUrls = (scrapingProject.queue || []).slice(0, BATCH_SIZE);
      const remainingQueue = (scrapingProject.queue || []).slice(BATCH_SIZE);
      
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

    // Handle crawling mode - crawl pages to discover URLs
    const crawlingProject = projects.find(p => p.status === 'crawling');
    if (crawlingProject) {
      if (!crawlingProject.queue || crawlingProject.queue.length === 0) {
        await updateProjectMutation.mutateAsync({ 
          id: crawlingProject.id, 
          updates: { 
            status: 'idle',
            stats: { ...crawlingProject.stats!, endTime: Date.now() }
          } 
        });
        return;
      }

      processingRef.current = true;
      const batchUrls = (crawlingProject.queue || []).slice(0, BATCH_SIZE);
      const remainingQueue = (crawlingProject.queue || []).slice(BATCH_SIZE);
      
      try {
        // Crawl pages and discover internal links
        const res = await apiRequest('POST', '/api/scrape/crawl', { 
          urls: batchUrls,
          domain: crawlingProject.domain 
        });
        const { results } = await res.json();

        let newResults = [...(crawlingProject.results || [])];
        let newQueue = [...remainingQueue];
        let newProcessed = [...(crawlingProject.processed || []), ...batchUrls];
        let newErrors = [...(crawlingProject.errors || [])];
        
        const existingLocs = new Set(newResults.map(r => r.loc));
        const existingProcessed = new Set(newProcessed);
        const existingQueue = new Set(newQueue);

        results.forEach((r: { url: string; links: string[]; data: any; error: string | null }) => {
          if (r.data) {
            // Add this URL as a result
            if (!existingLocs.has(r.url)) {
              newResults.push({
                loc: r.url,
                lastmod: undefined,
                changefreq: undefined,
                priority: undefined,
                images: r.data.images || [],
                videos: r.data.videos || [],
              });
              existingLocs.add(r.url);
            }
            
            // Add discovered links to queue
            r.links.forEach((link: string) => {
              if (!existingLocs.has(link) && !existingProcessed.has(link) && !existingQueue.has(link)) {
                newQueue.push(link);
                existingQueue.add(link);
              }
            });
          } else if (r.error) {
            newErrors.push({ 
              url: r.url, 
              message: r.error, 
              timestamp: new Date().toISOString() 
            });
          }
        });

        await updateProjectMutation.mutateAsync({
          id: crawlingProject.id,
          updates: {
            queue: newQueue,
            processed: newProcessed,
            results: newResults,
            errors: newErrors,
            stats: {
              ...crawlingProject.stats!,
              totalUrls: newResults.length,
              totalImages: newResults.reduce((acc, curr) => acc + (curr.images?.length || 0), 0),
              totalVideos: newResults.reduce((acc, curr) => acc + (curr.videos?.length || 0), 0),
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
      if (!contentScrapingProject.queue || contentScrapingProject.queue.length === 0) {
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
      const batchUrls = (contentScrapingProject.queue || []).slice(0, BATCH_SIZE);
      const remainingQueue = (contentScrapingProject.queue || []).slice(BATCH_SIZE);

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
    const active = projects.find(p => p.status === 'scraping' || p.status === 'content_scraping' || p.status === 'crawling');
    if (active && !processingRef.current) {
      const delay = active.status === 'crawling' ? 800 : (active.status === 'scraping' ? 500 : 1000);
      const timer = setTimeout(processStep, delay);
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
                        setDeleteConfirm({
                          open: true,
                          projectId: project.id,
                          projectName: project.displayName || project.domain,
                        });
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

              <div className="bg-card border border-border rounded-xl p-6 mt-6">
                <h3 className="text-sm font-medium text-foreground mb-4">{t('singleScrape')}</h3>
                <div className="flex gap-3">
                  <Input
                    type="text"
                    className="flex-1 bg-input"
                    placeholder={t('enterUrl')}
                    value={singleUrlInput}
                    onChange={(e) => setSingleUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && singleUrlInput && createSinglePageMutation.mutate(singleUrlInput)}
                    data-testid="single-url-input"
                  />
                  <Button
                    onClick={() => createSinglePageMutation.mutate(singleUrlInput)}
                    disabled={!singleUrlInput || createSinglePageMutation.isPending}
                    className="gap-2"
                    data-testid="single-scrape-button"
                  >
                    {createSinglePageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanText className="w-4 h-4" />}
                    {t('scrapeUrl')}
                  </Button>
                </div>
              </div>

              <div className="mt-6">
                <h2 className="text-xl font-semibold text-foreground mb-4">{t('singlePages')}</h2>
                {singlePagesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : singlePages.length === 0 ? (
                  <div className="bg-card border border-dashed border-border rounded-xl py-12 text-center">
                    <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-muted-foreground text-sm">{t('noSinglePages')}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {singlePages.map(page => (
                      <div 
                        key={page.id} 
                        className="bg-card border border-border rounded-lg p-4 hover-elevate cursor-pointer"
                        data-testid={`single-page-card-${page.id}`}
                        onClick={() => navigate(`/single-page/${page.id}`)}
                      >
                        <div className="flex items-start gap-3">
                          <div className="shrink-0 mt-0.5">
                            <FileText className="w-4 h-4 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-medium text-foreground truncate">
                              {page.title || page.url}
                            </h4>
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{page.domain}</p>
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <Badge 
                                variant={
                                  page.status === 'completed' ? 'default' : 
                                  page.status === 'error' ? 'destructive' : 
                                  'secondary'
                                }
                                className="text-[10px]"
                              >
                                {page.status === 'scraping' && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                                {page.status === 'completed' ? t('sequentialDataReady') : 
                                 page.status === 'error' ? t('error') : 
                                 page.status === 'scraping' ? t('scraping') : t('pending')}
                              </Badge>
                              {page.wordCount && page.wordCount > 0 && (
                                <span className="text-[10px] text-muted-foreground">{page.wordCount} {t('totalWords')}</span>
                              )}
                            </div>
                            {page.createdAt && (
                              <p className="text-[10px] text-muted-foreground mt-1.5">
                                {new Date(page.createdAt).toLocaleDateString(language === 'de' ? 'de-DE' : 'en-US')}
                              </p>
                            )}
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="shrink-0 h-7 w-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(t('deleteConfirm'))) {
                                deleteSinglePageMutation.mutate(page.id);
                              }
                            }}
                            data-testid={`delete-single-page-${page.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-2" data-testid="export-button">
                        <Download className="w-4 h-4" />
                        {t('exportJson')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={exportProject} className="gap-2" data-testid="export-json">
                        <Download className="w-4 h-4" />
                        {t('exportJson')}
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => {
                          if (!activeProject) return;
                          const results = activeProject.results || [];
                          const csvData = results.map(r => ({
                            url: r.loc,
                            lastmod: r.lastmod || '',
                            title: r.scrapedData?.title || '',
                            wordCount: r.scrapedData?.wordCount || 0,
                            images: r.images?.length || 0,
                          }));
                          const headers = ['url', 'lastmod', 'title', 'wordCount', 'images'];
                          const csv = [
                            headers.join(','),
                            ...csvData.map(row => headers.map(h => `"${String((row as any)[h]).replace(/"/g, '""')}"`).join(','))
                          ].join('\n');
                          const dataStr = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
                          const a = document.createElement('a');
                          a.href = dataStr;
                          a.download = `${(activeProject.displayName || activeProject.domain).replace(/[^a-z0-9]/gi, '_')}-export.csv`;
                          a.click();
                        }} 
                        className="gap-2" 
                        data-testid="export-csv"
                      >
                        <Download className="w-4 h-4" />
                        {t('exportCsv')}
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => {
                          if (!activeProject) return;
                          toast({ 
                            title: t('exportParquet'), 
                            description: 'Parquet export wird vom Server generiert...' 
                          });
                          window.open(`/api/projects/${activeProject.id}/export/parquet`, '_blank');
                        }} 
                        className="gap-2" 
                        data-testid="export-parquet"
                      >
                        <Download className="w-4 h-4" />
                        {t('exportParquet')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={() => {
                          if (!activeProject) return;
                          toast({ 
                            title: t('exportIncremental'), 
                            description: 'Inkrementeller Export wird vorbereitet...' 
                          });
                          window.open(`/api/projects/${activeProject.id}/export/incremental`, '_blank');
                        }} 
                        className="gap-2" 
                        data-testid="export-incremental"
                      >
                        <RefreshCw className="w-4 h-4" />
                        {t('exportIncremental')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {activeProject?.status === 'idle' && (
                    <Button 
                      size="sm"
                      onClick={() => resyncProjectMutation.mutate(activeProject)}
                      disabled={resyncProjectMutation.isPending}
                      className="gap-2"
                      data-testid="resync-button"
                    >
                      {resyncProjectMutation.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
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

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(open) => setDeleteConfirm(prev => ({ ...prev, open }))}
        title={t('deleteProject')}
        description={t('deleteConfirmMessage').replace('{name}', deleteConfirm.projectName)}
        confirmText={t('delete')}
        cancelText={t('cancel')}
        variant="destructive"
        onConfirm={() => {
          if (deleteConfirm.projectId) {
            deleteProjectMutation.mutate(deleteConfirm.projectId);
          }
        }}
      />
    </div>
  );
}
