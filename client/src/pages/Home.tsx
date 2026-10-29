import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { 
  Play, Square, Loader2, Download, Settings, 
  Trash2, ScanText, Globe, ArrowLeft, Plus, RefreshCw, Pause, X,
  Layers, Package, Cog, FileText, AlertTriangle, Pencil, Paperclip,
  CheckSquare, FolderPlus, History, Images
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
import LockTakeoverBanner from '@/components/LockTakeoverBanner';
import { isLockedByOtherTab as isLockedByOtherTabUtil } from '@/utils/lock-utils';
import Header from '@/components/Header';
import StatsCards from '@/components/StatsCards';
import UrlList from '@/components/UrlList';
import ErrorLogs from '@/components/ErrorLogs';
import ProjectCard from '@/components/ProjectCard';
import ProjectSettings from '@/components/ProjectSettings';
import ChunkingProgress from '@/components/ChunkingProgress';
import RagPackProgress from '@/components/RagPackProgress';
import ExportVersionsDialog from '@/components/ExportVersionsDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import LiveActivityFeed, { type LiveActivityEntry } from '@/components/LiveActivityFeed';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useLanguage } from '@/hooks/use-language';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { projectResultsQuery, projectResultsSummaryQuery } from '@/lib/project-result-queries';
import { activeProjectsForDispatch, refreshAfterProjectWrite, scheduleAfterStep } from '@/lib/crawl-dispatch';
import type { Project, SitemapUrlEntry, ProjectSettings as ProjectSettingsType, SinglePage } from '@shared/schema';
import { addDiscoveredLinks } from '@shared/crawl-depth';

// Maximum batch size hard cap (server also enforces MAX_CONCURRENCY = 50)
const MAX_BATCH_SIZE = 50;
// Minimum inter-batch delay in ms (prevents runaway tight loops)
const MIN_BATCH_DELAY_MS = 200;
// Safety cap for crawl discovery: stop adding new URLs to the frontier once the
// total of discovered + queued URLs reaches this bound, so parameterized links
// (pagination, filters) can never grow the crawl without limit.
const MAX_CRAWL_URLS = 20000;

// The tab identity must survive Vite hot updates and full page reloads of the
// SAME tab — otherwise every code update (HMR after a merge/edit) regenerates
// the ID, the stored scrape lock still names the old ID, and the tab falsely
// sees itself as "another tab" (phantom takeovers). sessionStorage is per-tab
// and per-session: distinct across real tabs, stable across reloads/HMR.
const TAB_ID = (() => {
  const STORAGE_KEY = 'mapscraper-tab-id';
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
  } catch {}
  let id: string;
  try {
    id = crypto.randomUUID();
  } catch {
    id = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, id);
  } catch {}
  return id;
})();

// Guards against "zombie" processing loops: the batch loop re-schedules itself
// via setTimeout closures. After a hot update (or remount) the OLD closure
// would keep running alongside the new one, doubling requests and writing
// stale data into the query cache. Each mount bumps the generation; loops
// from older generations stop themselves.
let scrapeLoopGeneration = 0;

// Maximum number of projects this tab processes in parallel. Per-domain rate
// limits are the real bottleneck, so a few concurrent projects (different
// domains) speed things up without overloading the browser or server.
const MAX_PARALLEL_PROJECTS = 3;

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
  const [showRagPackProgress, setShowRagPackProgress] = useState(false);
  const [showExportVersions, setShowExportVersions] = useState(false);
  const [attachmentSync, setAttachmentSync] = useState<{
    active: boolean;
    processed: number;
    total: number;
    pdfsFound: number;
    directPdfs: number;
    errors: number;
    done: boolean;
  } | null>(null);
  const [singleUrlInput, setSingleUrlInput] = useState('');
  const [wipeConfirmOpen, setWipeConfirmOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; projectId: number | null; projectName: string }>({
    open: false,
    projectId: null,
    projectName: '',
  });
  const [deleteSinglePageConfirm, setDeleteSinglePageConfirm] = useState<{ open: boolean; pageId: number | null; pageName: string }>({
    open: false,
    pageId: null,
    pageName: '',
  });
  const [renameSinglePage, setRenameSinglePage] = useState<{ open: boolean; pageId: number | null; currentTitle: string; newTitle: string }>({
    open: false,
    pageId: null,
    currentTitle: '',
    newTitle: '',
  });
  const [selectedSinglePages, setSelectedSinglePages] = useState<Set<number>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [convertDialog, setConvertDialog] = useState<{ open: boolean; projectName: string; deleteSinglePages: boolean }>({ open: false, projectName: '', deleteSinglePages: false });
  // Lock-takeover: true while the POST /take-lock request is in flight
  const [isTakingLock, setIsTakingLock] = useState(false);
  // Rate-limit rollback modal: shown after automatic parallelRequests rollback
  const [rateLimitModal, setRateLimitModal] = useState<{
    open: boolean;
    projectId: number;
    fromValue: number;
    toValue: number;
    customValue: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Per-project mutex: IDs of projects whose batch is currently in flight in
  // this tab. Replaces the old single global boolean so several projects can
  // be processed in parallel (capped by MAX_PARALLEL_PROJECTS).
  const processingProjectsRef = useRef<Set<number>>(new Set());
  const abortedProjectsRef = useRef<Set<number>>(new Set());
  // Projects for which pause/stop was requested in this tab. In-flight batches
  // check this after their network call so they don't persist results past the
  // requested pause/stop boundary (the batch is simply discarded and re-done on resume).
  const pauseRequestedRef = useRef<Set<number>>(new Set());
  // Per-project extraction queue (source of truth between content batches).
  const contentQueueRef = useRef<Map<number, string[]>>(new Map());
  // Per-project earliest time the next batch may start (enforces the
  // project's delayMs setting independently for each parallel project).
  const nextEligibleAtRef = useRef<Map<number, number>>(new Map());
  // Per-project pending kick timers so we never stack duplicate timers
  // (value = timeout handle so it can be cancelled on cleanup).
  const pendingKickRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // Per-project last activity timestamp for stuck detection.
  const lastActivityRef = useRef<Map<number, number>>(new Map());
  // Per-project timestamp of the last dispatch, used for fair (least-recently
  // -served first) scheduling so projects beyond the concurrency cap are never
  // starved by the fixed list order.
  const lastDispatchedAtRef = useRef<Map<number, number>>(new Map());
  // Per-project step generation. Bumped whenever a project's processing is
  // externally reset (takeover, restart, delete, watchdog). An in-flight
  // batch that observes a bumped generation discards its results instead of
  // persisting them — clearing a mutex alone is not cancellation.
  const stepGenRef = useRef<Map<number, number>>(new Map());

  // Centralized cleanup for a project's client-side scheduling state.
  // Bumps the generation (cancels in-flight persistence), cancels pending
  // kick timers, and drops all per-project map entries.
  const clearProjectScheduling = useCallback((projectId: number) => {
    stepGenRef.current.set(projectId, (stepGenRef.current.get(projectId) ?? 0) + 1);
    const kickTimer = pendingKickRef.current.get(projectId);
    if (kickTimer !== undefined) {
      clearTimeout(kickTimer);
      pendingKickRef.current.delete(projectId);
    }
    contentQueueRef.current.delete(projectId);
    nextEligibleAtRef.current.delete(projectId);
    lastActivityRef.current.delete(projectId);
    lastDispatchedAtRef.current.delete(projectId);
  }, []);
  // Always points to the latest processStep closure so that scheduled
  // callbacks (setTimeout inside scheduleNextBatch) never call a stale version.
  const processStepRef = useRef<() => Promise<void>>(async () => {});
  const loopGenRef = useRef(0);
  useEffect(() => {
    loopGenRef.current = ++scrapeLoopGeneration;
  }, []);
  // Live progress: per-project rolling feed of recently processed URLs +
  // per-project session stats for rate/ETA. Keyed by project ID so parallel
  // projects don't clobber each other's displays.
  const [liveFeed, setLiveFeed] = useState<Record<number, LiveActivityEntry[]>>({});
  const [sessionStats, setSessionStats] = useState<Record<number, { startTime: number; processedCount: number }>>({});

  // Paginated results table state (kept in the parent so switching tabs/pages
  // doesn't lose position, and so page size / filters can be reset when the
  // active project changes).
  const [resultsPage, setResultsPage] = useState(0);
  const [resultsPageSize, setResultsPageSize] = useState(500);
  const [resultsSearch, setResultsSearch] = useState('');
  const [resultsFolder, setResultsFolder] = useState<string | null>(null);
  const [activeResultsTab, setActiveResultsTab] = useState<'urls' | 'errors'>('urls');

  const recordActivity = useCallback((projectId: number, entries: LiveActivityEntry[]) => {
    if (entries.length === 0) return;
    setLiveFeed(prev => ({
      ...prev,
      [projectId]: [...entries, ...(prev[projectId] || [])].slice(0, 30),
    }));
    setSessionStats(prev => {
      const existing = prev[projectId];
      return {
        ...prev,
        [projectId]: existing
          ? { ...existing, processedCount: existing.processedCount + entries.length }
          : { startTime: Date.now(), processedCount: entries.length },
      };
    });
  }, []);

  const { data: projects = [], isLoading, refetch: refetchProjects } = useQuery<Project[]>({
    queryKey: ['/api/projects'],
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    staleTime: 1000, // Consider data stale after 1 second
  });

  // Separate query for active project detail - lightweight metadata + counts
  // only; the results table body is fetched separately (paginated) below so
  // opening a huge project never has to transfer its whole result set.
  const { data: activeProjectDetail, refetch: refetchActiveProject } = useQuery<Project>({
    queryKey: ['/api/projects', activeProjectId],
    enabled: activeProjectId !== null,
    refetchOnMount: true,
    staleTime: 2000,
  });

  // Reset pagination/filters whenever the active project or tab changes.
  useEffect(() => {
    setResultsPage(0);
    setResultsSearch('');
    setResultsFolder(null);
  }, [activeProjectId, activeResultsTab]);

  // Debounce the search box so every keystroke doesn't trigger a fresh
  // server query.
  const [resultsSearchDebounced, setResultsSearchDebounced] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setResultsSearchDebounced(resultsSearch), 300);
    return () => clearTimeout(handle);
  }, [resultsSearch]);
  useEffect(() => {
    setResultsPage(0);
  }, [resultsSearchDebounced, resultsFolder]);

  const resultsQueryUrl = useMemo(() => {
    if (activeProjectId == null || activeResultsTab !== 'urls') return null;
    const params = new URLSearchParams({
      offset: String(resultsPage * resultsPageSize),
      limit: String(resultsPageSize),
    });
    if (resultsSearchDebounced) params.set('search', resultsSearchDebounced);
    if (resultsFolder) params.set('folder', resultsFolder);
    return `/api/projects/${activeProjectId}/results?${params.toString()}`;
  }, [activeProjectId, resultsPage, resultsPageSize, resultsSearchDebounced, resultsFolder, activeResultsTab]);

  const { data: resultsPageData, isLoading: isResultsPageLoading, isFetching: isResultsPageFetching } = useQuery(
    projectResultsQuery(activeProjectId, resultsQueryUrl),
  );

  const { data: resultsSummary } = useQuery(projectResultsSummaryQuery(activeProjectId));

  const { data: sharedImagesData, refetch: refetchSharedImages } = useQuery<{
    computed: boolean;
    lastComputedAt: string | null;
    threshold: number | null;
    images: Array<{ id: string; count: number; url?: string }>;
  }>({
    queryKey: [`/api/projects/${activeProjectId}/shared-images`],
    enabled: activeProjectId !== null,
    staleTime: 10000,
  });

  const [isDeduping, setIsDeduping] = useState(false);

  const dedupeImagesMutation = useMutation({
    mutationFn: async (projectId: number) => {
      const res = await apiRequest('POST', `/api/projects/${projectId}/dedupe-images`);
      return res.json();
    },
    onSuccess: (data) => {
      refetchSharedImages();
      toast({
        title: t('imageDedupResult'),
        description: `${data.sharedImageCount} ${t('imageDedupSharedImages')} · ${data.collapsedElementsTotal} ${t('imageDedupSaved')}`,
      });
      setIsDeduping(false);
    },
    onError: () => {
      toast({ title: t('error'), variant: 'destructive' });
      setIsDeduping(false);
    },
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

  const renameSinglePageMutation = useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) => {
      await apiRequest('PUT', `/api/single-pages/${id}`, { title });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/single-pages'] });
      setRenameSinglePage({ open: false, pageId: null, currentTitle: '', newTitle: '' });
      toast({ title: t('success'), description: t('pageRenamed') || 'Seite umbenannt' });
    },
  });

  const convertToProjectMutation = useMutation({
    mutationFn: async ({ name, singlePageIds, deleteSinglePages }: { name: string; singlePageIds: number[]; deleteSinglePages: boolean }) => {
      const res = await apiRequest('POST', '/api/projects/from-single-pages', { name, singlePageIds, deleteSinglePages });
      return res.json();
    },
    onSuccess: (project: Project) => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      queryClient.invalidateQueries({ queryKey: ['/api/single-pages'] });
      setSelectedSinglePages(new Set());
      setSelectionMode(false);
      setConvertDialog({ open: false, projectName: '', deleteSinglePages: false });
      setActiveProjectId(project.id);
      toast({ title: t('success'), description: t('convertToProjectSuccess') });
    },
    onError: () => {
      toast({ title: t('error'), variant: 'destructive' });
    },
  });

  // Use full project detail when available, fall back to list item
  const activeProject = useMemo(() => {
    if (activeProjectDetail && activeProjectDetail.id === activeProjectId) {
      return activeProjectDetail;
    }
    return projects.find(p => p.id === activeProjectId);
  }, [projects, activeProjectId, activeProjectDetail]);

  const createProjectMutation = useMutation({
    mutationFn: async (domain: string) => {
      setIsCreating(true);
      const discoverRes = await apiRequest('POST', '/api/scrape/discover', { domain });
      const discoverData = await discoverRes.json();
      const { sitemaps, wikiJsPages, isWikiJs, moodlePages, isMoodle } = discoverData;
      
      // If Wiki.js or Moodle site detected, use the discovered pages directly
      let initialQueue = sitemaps;
      let useCrawlMode = false;
      let isWikiJsSite = isWikiJs || false;
      let isMoodleSite = isMoodle || false;
      let initialResults: Array<{ loc: string; images: Array<unknown>; videos: Array<unknown> }> = [];
      let projectStatus: string = 'scraping';
      
      if (isWikiJs && wikiJsPages && wikiJsPages.length > 0) {
        // Wiki.js site - convert URLs to result format and start content scraping
        initialResults = wikiJsPages.map((url: string) => ({ loc: url, images: [], videos: [] }));
        initialQueue = wikiJsPages; // Queue for content scraping
        projectStatus = 'content_scraping';
        console.log(`[Wiki.js] Using ${wikiJsPages.length} discovered pages for content scraping`);
      } else if (isMoodle && moodlePages && moodlePages.length > 0) {
        // Moodle site - convert course URLs to result format and start content scraping
        initialResults = moodlePages.map((url: string) => ({ loc: url, images: [], videos: [] }));
        initialQueue = moodlePages; // Queue for content scraping
        projectStatus = 'content_scraping';
        console.log(`[Moodle] Using ${moodlePages.length} discovered course pages for content scraping`);
      } else if (sitemaps.length === 0) {
        // No sitemaps found - use crawl mode starting from base URL
        let baseUrl = domain.trim();
        if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
        baseUrl = baseUrl.replace(/\/$/, '');
        initialQueue = [baseUrl]; // Start with the base URL
        useCrawlMode = true;
        projectStatus = 'crawling';
      }
      
      const project = await apiRequest('POST', '/api/projects', {
        domain: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        displayName: domain.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        status: projectStatus,
        queue: initialQueue,
        crawlDepths: useCrawlMode ? { [initialQueue[0]]: 0 } : {},
        processed: [],
        results: initialResults,
        errors: [],
        stats: {
          totalSitemaps: (isWikiJsSite || isMoodleSite) ? 0 : sitemaps.length,
          processedSitemaps: 0,
          totalUrls: isWikiJsSite ? wikiJsPages?.length || 0 : (isMoodleSite ? moodlePages?.length || 0 : (useCrawlMode ? 1 : 0)),
          totalImages: 0,
          totalVideos: 0,
          startTime: Date.now(),
        },
      });
      const projectData = await project.json();
      return { 
        ...projectData, 
        isWikiJs: isWikiJsSite, 
        isMoodle: isMoodleSite,
        wikiPageCount: wikiJsPages?.length || 0,
        moodlePageCount: moodlePages?.length || 0,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      setActiveProjectId(result.id);
      setDomainInput('');
      setIsCreating(false);
      setShowNewProject(false);
      
      // Show info toast based on mode
      if (result.isWikiJs) {
        toast({ 
          title: 'Wiki.js erkannt', 
          description: `${result.wikiPageCount} Seiten gefunden und werden gescrapt.`,
        });
      } else if (result.isMoodle) {
        toast({ 
          title: 'Moodle erkannt', 
          description: `${result.moodlePageCount} Kursseiten gefunden und werden gescrapt.`,
        });
      } else if (result.status === 'crawling') {
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
    mutationFn: async ({ id, updates, expectedVersion }: { id: number; updates: Partial<Project>; expectedVersion?: number }) => {
      // Check if project was marked for deletion - don't update if aborted
      if (abortedProjectsRef.current.has(id)) {
        console.log(`[Update] Skipping update for aborted project ${id}`);
        return null;
      }
      const res = await apiRequest('PUT', `/api/projects/${id}`, {
        ...updates,
        lockOwner: TAB_ID,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      });
      return res.json();
    },
    onSuccess: async (data) => {
      // Only invalidate if we actually updated something (not aborted)
      await refreshAfterProjectWrite(queryClient, data);
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: async (id: number) => {
      // CRITICAL: Mark project as aborted IMMEDIATELY to stop all active processing
      abortedProjectsRef.current.add(id);
      // Cancel this project's processing chain: bump its generation and drop
      // all scheduling state. The running slot is NOT force-cleared — the
      // in-flight step's .finally() releases it once the step settles.
      clearProjectScheduling(id);
      
      console.log(`[Delete] Project ${id} marked as aborted, stopping all processing`);
      
      // Now delete from database
      await apiRequest('DELETE', `/api/projects/${id}`);
      return id;
    },
    onSuccess: (deletedId) => {
      // Keep project in aborted set for a while to prevent race conditions
      setTimeout(() => {
        abortedProjectsRef.current.delete(deletedId);
      }, 5000);
      
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      if (activeProjectId === deletedId) setActiveProjectId(null);
      
      toast({ title: t('success'), description: t('projectDeleted') || 'Projekt gelöscht' });
    },
    onError: (error, id) => {
      // On error, remove from aborted set
      abortedProjectsRef.current.delete(id);
      toast({ title: t('error'), description: t('deleteError') || 'Fehler beim Löschen', variant: 'destructive' });
    },
  });

  const resyncProjectMutation = useMutation({
    mutationFn: async (project: Project) => {
      // Re-discover sitemaps/URLs for the project
      let domain = project.domain;
      if (!domain.startsWith('http')) domain = `https://${domain}`;
      
      const discoverRes = await apiRequest('POST', '/api/scrape/discover', { domain });
      const discoverData = await discoverRes.json();
      const { sitemaps, wikiJsPages, isWikiJs, moodlePages, isMoodle } = discoverData;
      
      // If Wiki.js or Moodle site detected, use the discovered pages directly
      let initialQueue = sitemaps;
      let useCrawlMode = false;
      let isWikiJsSite = isWikiJs || false;
      let isMoodleSite = isMoodle || false;
      let initialResults: Array<{ loc: string; images: Array<unknown>; videos: Array<unknown> }> = [];
      let projectStatus: string = 'scraping';
      
      if (isWikiJs && wikiJsPages && wikiJsPages.length > 0) {
        // Wiki.js site - convert URLs to result format and start content scraping
        initialResults = wikiJsPages.map((url: string) => ({ loc: url, images: [], videos: [] }));
        initialQueue = wikiJsPages; // Queue for content scraping
        projectStatus = 'content_scraping';
        console.log(`[Wiki.js] Resync: Using ${wikiJsPages.length} discovered pages for content scraping`);
      } else if (isMoodle && moodlePages && moodlePages.length > 0) {
        // Moodle site - convert course URLs to result format and start content scraping
        initialResults = moodlePages.map((url: string) => ({ loc: url, images: [], videos: [] }));
        initialQueue = moodlePages; // Queue for content scraping
        projectStatus = 'content_scraping';
        console.log(`[Moodle] Resync: Using ${moodlePages.length} discovered course pages for content scraping`);
      } else if (sitemaps.length === 0) {
        let baseUrl = domain.trim();
        if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
        baseUrl = baseUrl.replace(/\/$/, '');
        initialQueue = [baseUrl];
        useCrawlMode = true;
        projectStatus = 'crawling';
      }
      
      // Update project with new queue and reset stats
      const res = await apiRequest('PUT', `/api/projects/${project.id}`, {
        status: projectStatus,
        queue: initialQueue,
        crawlDepths: useCrawlMode ? { [initialQueue[0]]: 0 } : {},
        processed: [],
        results: initialResults,
        errors: [],
        stats: {
          totalSitemaps: (isWikiJsSite || isMoodleSite) ? 0 : sitemaps.length,
          processedSitemaps: 0,
          totalUrls: isWikiJsSite ? wikiJsPages?.length || 0 : (isMoodleSite ? moodlePages?.length || 0 : (useCrawlMode ? 1 : 0)),
          totalImages: 0,
          totalVideos: 0,
          startTime: Date.now(),
        },
      });
      return { 
        project: await res.json(), 
        useCrawlMode, 
        isWikiJs: isWikiJsSite, 
        wikiPageCount: wikiJsPages?.length || 0 
      };
    },
    onSuccess: ({ useCrawlMode, isWikiJs, wikiPageCount }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      
      if (isWikiJs) {
        toast({ 
          title: 'Wiki.js erkannt', 
          description: `${wikiPageCount} Seiten gefunden und werden gescrapt.`,
        });
      } else if (useCrawlMode) {
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
    onError: (error: any) => {
      console.error('[Resync] Error:', error);
      const errorMessage = error?.message || error?.toString() || t('initError');
      toast({ 
        title: t('error'), 
        description: `${t('initError')}: ${errorMessage}`, 
        variant: 'destructive' 
      });
    },
    retry: 2,
    retryDelay: 1000,
  });

  // Notify once per project when another tab holds the scrape lock
  const lockNotifiedRef = useRef<Set<number>>(new Set());
  const notifyLockedByOtherTab = useCallback((projectId: number) => {
    console.log(`[Process] Project ${projectId} is locked by another tab, not taking over`);
    if (!lockNotifiedRef.current.has(projectId)) {
      lockNotifiedRef.current.add(projectId);
      toast({
        title: t('scrapeLockedTitle') || 'Verarbeitung in anderem Tab',
        description: t('scrapeLockedDescription') || 'Dieses Projekt wird bereits in einem anderen Tab verarbeitet. Dieser Tab übernimmt nicht.',
      });
    }
  }, [toast, t]);

  // Force-take the scrape lock from another tab. Used by the "Übernehmen" button.
  const takeLock = useCallback(async (projectId: number) => {
    setIsTakingLock(true);
    try {
      const res = await apiRequest('POST', `/api/projects/${projectId}/take-lock`, { lockOwner: TAB_ID });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as any).message || 'Failed to take lock');
      }
      lockNotifiedRef.current.delete(projectId);
      // Cancel any in-flight step (bumps generation) and clear scheduling
      // state; the running slot is released by the old step's .finally().
      clearProjectScheduling(projectId);
      await refetchProjects();
      // Kick off the processing loop immediately now that this tab owns the lock.
      processStepRef.current().catch(err => {
        console.error('[TakeLock] processStep failed:', err);
      });
      toast({ title: t('takeLockSuccess') || 'Verarbeitung übernommen' });
    } catch (err) {
      toast({ title: t('error'), description: (err as Error).message, variant: 'destructive' });
    } finally {
      setIsTakingLock(false);
    }
  }, [t, toast, refetchProjects, clearProjectScheduling]);

  // A concurrent write (other tab or server action) won the race: discard this
  // batch, refresh from the server, and let the owner keep going.
  const handleWriteConflict = useCallback((projectId: number) => {
    console.warn(`[Process] Write conflict on project ${projectId}, discarding batch and refreshing`);
    notifyLockedByOtherTab(projectId);
    queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
    queryClient.invalidateQueries({ queryKey: ['/api/projects', projectId] });
  }, [notifyLockedByOtherTab]);

  // Sets the project's next eligible time and schedules a re-dispatch after
  // its per-project delay (deduped so timers never stack per project).
  const scheduleProjectKick = useCallback((projectId: number, delayMs: number) => {
    nextEligibleAtRef.current.set(projectId, Date.now() + delayMs);
    if (pendingKickRef.current.has(projectId)) return;
    const timer = setTimeout(() => {
      pendingKickRef.current.delete(projectId);
      processStepRef.current().catch(err => {
        console.error('[Process] Step failed, will retry:', err);
      });
    }, delayMs);
    pendingKickRef.current.set(projectId, timer);
  }, []);

  // Fire-and-forget: re-runs image dedup after a crawl/scrape finishes so
  // newly-recurring images are collapsed automatically without requiring a
  // manual /dedupe-images trigger. Ignores 409 conflicts (another tab is
  // already doing it) and any other transient errors to keep the caller's
  // completion path clean. Runs fully in the background — does not block
  // the transition to idle or show blocking UI.
  const triggerImageDedupAsync = useCallback((projectId: number) => {
    fetch(`/api/projects/${projectId}/dedupe-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lockOwner: `auto-dedup-${TAB_ID}` }),
      credentials: 'include',
    })
      .then(async res => {
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          console.log(
            `[ImageDedup] Project ${projectId}: auto-dedup complete — ` +
            `${data.sharedImageCount ?? '?'} shared image(s), ` +
            `${data.newlyDetected ?? '?'} new, ` +
            `${data.collapsedElementsTotal ?? '?'} element(s) collapsed`,
          );
          queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
          queryClient.invalidateQueries({ queryKey: ['/api/projects', projectId] });
        } else if (res.status === 409) {
          // Another tab or session is already running dedup — that's fine.
          console.log(`[ImageDedup] Project ${projectId}: dedup skipped (locked by another session)`);
        } else {
          console.warn(`[ImageDedup] Project ${projectId}: dedup returned ${res.status}`);
        }
      })
      .catch(err => {
        // Network error — not critical, user can always run it manually.
        console.warn(`[ImageDedup] Project ${projectId}: dedup request failed:`, err);
      });
  }, [queryClient]);

  // Processes ONE batch for ONE project. Only called by the dispatcher
  // (processStep) below, which guarantees per-project mutual exclusion via
  // processingProjectsRef.
  const processProjectStep = useCallback(async (project: Project, gen: number) => {
    // True when this step was externally reset (takeover, restart, delete,
    // watchdog) while a network call was in flight — discard, don't persist.
    const isStaleGen = () => (stepGenRef.current.get(project.id) ?? 0) !== gen;
    const scrapingProject = project.status === 'scraping' ? project : null;
    if (scrapingProject) {
      // Check if project was marked for deletion - stop immediately
      if (abortedProjectsRef.current.has(scrapingProject.id)) {
        console.log(`[Process] Project ${scrapingProject.id} was aborted, skipping`);
        return;
      }
      // Another tab is actively processing this project - don't take over
      if (isLockedByOtherTab(scrapingProject)) {
        notifyLockedByOtherTab(scrapingProject.id);
        return;
      }
      
      if (!scrapingProject.queue || scrapingProject.queue.length === 0) {
        await updateProjectMutation.mutateAsync({ 
          id: scrapingProject.id, 
          updates: { 
            status: 'idle',
            stats: { ...scrapingProject.stats!, endTime: Date.now() }
          } 
        });
        // Auto-run image dedup now that scraping is complete so newly-recurring
        // images are collapsed without requiring a manual trigger.
        triggerImageDedupAsync(scrapingProject.id);
        return;
      }

      lastActivityRef.current.set(scrapingProject.id, Date.now());

      try {
        // PERFORMANCE: Like the crawl loop, use the lightweight crawl-state
        // endpoint instead of the full project detail. On large projects the
        // full detail (results incl. images/videos/scrapedData) reaches tens
        // of MB per batch; the sitemap loop only needs result LOCs for dedup.
        const detailRes = await apiRequest('GET', `/api/projects/${scrapingProject.id}/crawl-state`);
        const scrapeState: {
          queue: string[];
          crawlDepths: Record<string, number>;
          processed: string[];
          stats: any;
          projectSettings: ProjectSettingsType | null;
          version: number;
          scrapeLock: { owner: string; expiresAt: number } | null;
          resultLocs: string[];
        } = await detailRes.json();
        // Re-check with fresh data: another tab may have grabbed the lock meanwhile
        if (isLockedByOtherTab(scrapeState)) {
          notifyLockedByOtherTab(scrapingProject.id);
          return;
        }
        const scrapeQueue = scrapeState.queue || [];
        const scrapeBatchSize = Math.min(
          Math.max(1, scrapeState.projectSettings?.scraping?.parallelRequests ?? 10),
          MAX_BATCH_SIZE,
        );
        const batchUrls = scrapeQueue.slice(0, scrapeBatchSize);
        const remainingQueue = scrapeQueue.slice(scrapeBatchSize);

        const results = await Promise.all(batchUrls.map(async (url) => {
          try {
            const res = await apiRequest('POST', '/api/scrape/sitemap', { url });
            return { url, data: await res.json(), error: null };
          } catch (err) {
            return { url, data: null, error: (err as Error).message };
          }
        }));

        // Delta-based merge: only the batch's NEW results/errors/processed are
        // collected and sent to the server, which appends them in SQL. The
        // full arrays never travel to the browser or back.
        const resultsAppend: SitemapUrlEntry[] = [];
        const errorsAppend: Array<{ url: string; message: string; timestamp: string }> = [];
        const processedAppend = [...batchUrls];
        let newQueue = [...remainingQueue];
        let sitemapsProcessed = 0;
        let newSitemapsFound = 0;

        const existingLocs = new Set(scrapeState.resultLocs || []);
        const existingProcessed = new Set([...(scrapeState.processed || []), ...processedAppend]);
        const existingQueue = new Set(newQueue);

        results.forEach(res => {
          sitemapsProcessed++;
          if (res.data) {
            const { urls, subSitemaps } = res.data;
            urls.forEach((u: SitemapUrlEntry) => {
              if (!existingLocs.has(u.loc)) {
                resultsAppend.push(u);
                existingLocs.add(u.loc);
              }
            });
            subSitemaps.forEach((s: string) => {
              if (!existingProcessed.has(s) && !existingQueue.has(s)) {
                newQueue.push(s);
                existingQueue.add(s);
                newSitemapsFound++;
              }
            });
          } else if (res.error) {
            errorsAppend.push({ 
              url: res.url, 
              message: res.error, 
              timestamp: new Date().toISOString() 
            });
          }
        });

        // Check again if project was aborted or paused/stopped during API call
        if (abortedProjectsRef.current.has(scrapingProject.id) || pauseRequestedRef.current.has(scrapingProject.id) || isStaleGen()) {
          console.log(`[Process] Project ${scrapingProject.id} was aborted/paused/reset during processing, not saving results`);
          return;
        }

        recordActivity(scrapingProject.id, results.map(res => ({
          url: res.url,
          ok: !res.error,
          message: res.error || undefined,
          timestamp: Date.now(),
        })));
        
        try {
          // Stats are updated incrementally — the client no longer holds the
          // full results array, so totals are prior stats + this batch's delta.
          // totalUrls is recomputed authoritatively on the server.
          const priorResultCount = (scrapeState.resultLocs || []).length;
          const batchImages = resultsAppend.reduce((acc, curr) => acc + (curr.images?.length || 0), 0);
          const batchVideos = resultsAppend.reduce((acc, curr) => acc + ((curr as any).videos?.length || 0), 0);

          await apiRequest('POST', `/api/projects/${scrapingProject.id}/crawl-progress`, {
            lockOwner: TAB_ID,
            expectedVersion: scrapeState.version,
            queue: newQueue,
            crawlDepths: scrapeState.crawlDepths || {},
            processedAppend,
            resultsAppend,
            errorsAppend,
            stats: {
              ...(scrapeState.stats || {}),
              processedSitemaps: (scrapeState.stats?.processedSitemaps || 0) + sitemapsProcessed,
              totalSitemaps: (scrapeState.stats?.totalSitemaps || 0) + newSitemapsFound,
              totalUrls: priorResultCount + resultsAppend.length,
              totalImages: (scrapeState.stats?.totalImages || 0) + batchImages,
              totalVideos: (scrapeState.stats?.totalVideos || 0) + batchVideos,
            },
          });
          queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
          // Self-schedule the next batch with the project's own delay so
          // parallel projects each keep their configured pace.
          scheduleProjectKick(scrapingProject.id, Math.max(
            MIN_BATCH_DELAY_MS,
            scrapeState.projectSettings?.scraping?.delayMs ?? 500,
          ));
        } catch (err) {
          if (isConflictError(err)) {
            handleWriteConflict(scrapingProject.id);
            return;
          }
          throw err;
        }
      } finally {
        lastActivityRef.current.set(scrapingProject.id, Date.now());
      }
      return;
    }

    // Handle crawling mode - crawl pages to discover URLs
    const crawlingProject = project.status === 'crawling' ? project : null;
    if (crawlingProject) {
      // Check if project was marked for deletion - stop immediately
      if (abortedProjectsRef.current.has(crawlingProject.id)) {
        console.log(`[Process] Crawling project ${crawlingProject.id} was aborted, skipping`);
        return;
      }
      // Another tab is actively processing this project - don't take over
      if (isLockedByOtherTab(crawlingProject)) {
        notifyLockedByOtherTab(crawlingProject.id);
        return;
      }
      
      if (!crawlingProject.queue || crawlingProject.queue.length === 0) {
        // Incremental update re-crawl finished: let the server diff results
        // against reachable URLs (flags removed pages, queues new ones).
        if ((crawlingProject as any).updateRun?.phase === 'discovery') {
          try {
            // Raw fetch: apiRequest throws on non-OK, but we need the status
            // code to distinguish terminal failures from transient conflicts.
            const res = await fetch(`/api/projects/${crawlingProject.id}/finish-update`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lockOwner: TAB_ID }),
              credentials: 'include',
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.summary) {
              const s = data.summary;
              toast({
                title: t('updateStarted'),
                description: (s.newUrls + s.removedUrls) === 0
                  ? t('updateNoChanges')
                  : `${s.newUrls} ${t('updateSummaryNew')}, ${s.removedUrls} ${t('updateSummaryRemoved')}`,
              });
              // When there's nothing new to scrape the project is already idle;
              // trigger dedup now. When there IS content to scrape, the
              // content_scraping completion branch will trigger it instead.
              if (s.queued === 0) {
                triggerImageDedupAsync(crawlingProject.id);
              }
            } else if (res.status === 409) {
              // Another tab holds the lease or a concurrent write happened —
              // refetch and let whoever owns the project finish the update.
              console.warn('[FinishUpdate] Conflict (409), backing off:', data.message);
            } else if (!res.ok) {
              // Terminal failure (400/500): clear the update run so the loop
              // doesn't retry forever, and return the project to idle.
              console.error('[FinishUpdate] Failed:', res.status, data.message);
              toast({ title: t('error'), description: data.message || 'Update failed', variant: 'destructive' });
              await updateProjectMutation.mutateAsync({
                id: crawlingProject.id,
                updates: { status: 'idle', crawlDepths: {}, updateRun: null } as any,
              });
            }
          } catch (err) {
            // Network error: leave state untouched; the loop retries next tick.
            console.error('[FinishUpdate] Network error, will retry:', err);
          }
          queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
          return;
        }
        await updateProjectMutation.mutateAsync({ 
          id: crawlingProject.id, 
          updates: { 
            status: 'idle',
            crawlDepths: {},
            stats: { ...crawlingProject.stats!, endTime: Date.now() }
          } 
        });
        // Auto-run image dedup now that the crawl is complete.
        triggerImageDedupAsync(crawlingProject.id);
        return;
      }

      lastActivityRef.current.set(crawlingProject.id, Date.now());

      try {
        // PERFORMANCE: Use the lightweight crawl-state endpoint instead of the
        // full project detail. On large crawls the full detail (results incl.
        // images/videos) reaches tens of MB and made every 10-URL batch take
        // ~45 s. The crawl loop only needs result LOCs for dedup.
        const detailRes = await apiRequest('GET', `/api/projects/${crawlingProject.id}/crawl-state`);
        const crawlState: {
          queue: string[];
          crawlDepths: Record<string, number>;
          processed: string[];
          stats: any;
          projectSettings: ProjectSettingsType | null;
          version: number;
          scrapeLock: { owner: string; expiresAt: number } | null;
          resultLocs: string[];
        } = await detailRes.json();
        // Re-check with fresh data: another tab may have grabbed the lock meanwhile
        if (isLockedByOtherTab(crawlState)) {
          notifyLockedByOtherTab(crawlingProject.id);
          return;
        }
        const crawlQueue = crawlState.queue || [];
        const crawlBatchSize = Math.min(
          Math.max(1, crawlState.projectSettings?.scraping?.parallelRequests ?? 10),
          MAX_BATCH_SIZE,
        );
        const batchUrls = crawlQueue.slice(0, crawlBatchSize);
        const remainingQueue = crawlQueue.slice(crawlBatchSize);

        // Depth tracking: enforce the project's maxDepth setting. URLs without
        // a recorded depth (e.g. projects created before depth tracking) count
        // as depth 0, so existing crawls keep their previous behavior.
        const maxDepth = crawlState.projectSettings?.scraping?.maxDepth ?? 5;
        const newCrawlDepths: Record<string, number> = { ...(crawlState.crawlDepths || {}) };

        // Crawl pages and discover internal links
        const res = await apiRequest('POST', '/api/scrape/crawl', { 
          urls: batchUrls,
          domain: crawlingProject.domain,
          projectId: crawlingProject.id,
        });
        const { results, rateLimitDetected, suggestedParallelRequests } = await res.json();

        // Reconcile progress: the server may have trimmed the batch to its
        // effective concurrency limit. Only mark URLs the server actually
        // attempted as processed; put any trimmed URLs back at the front of the
        // queue so they are retried in the next batch.
        const serverProcessedSet = new Set(results.map((r: { url: string }) => r.url));
        const untrimmedUrls = batchUrls.filter((u: string) => !serverProcessedSet.has(u));

        // Delta-based merge: only the batch's NEW results/errors/processed are
        // collected and sent to the server, which appends them in SQL. The
        // full arrays never travel to the browser or back.
        const resultsAppend: Array<{ loc: string; images: any[]; videos: any[] }> = [];
        const errorsAppend: Array<{ url: string; message: string; timestamp: string }> = [];
        const processedAppend = batchUrls.filter((u: string) => serverProcessedSet.has(u));
        // Prepend untrimmed URLs so they are the very next to be crawled.
        let newQueue = [...untrimmedUrls, ...remainingQueue];

        const priorResultCount = (crawlState.resultLocs || []).length;
        const existingLocs = new Set(crawlState.resultLocs || []);
        const existingProcessed = new Set([...(crawlState.processed || []), ...processedAppend]);
        const existingQueue = new Set(newQueue);

        results.forEach((r: { url: string; links: string[]; data: any; error: string | null }) => {
          if (r.data) {
            // Add this URL as a result
            if (!existingLocs.has(r.url)) {
              resultsAppend.push({
                loc: r.url,
                images: r.data.images || [],
                videos: r.data.videos || [],
              });
              existingLocs.add(r.url);
            }
            
            // Add discovered links to queue (bounded by maxDepth and MAX_CRAWL_URLS)
            addDiscoveredLinks(
              {
                queue: newQueue,
                depths: newCrawlDepths,
                resultCount: priorResultCount + resultsAppend.length,
                existingLocs,
                existingProcessed,
                existingQueue,
              },
              r.url,
              r.links,
              maxDepth,
              MAX_CRAWL_URLS,
            );
          } else if (r.error) {
            errorsAppend.push({ 
              url: r.url, 
              message: r.error, 
              timestamp: new Date().toISOString() 
            });
          }
        });

        // Check again if project was aborted or paused/stopped during API call
        if (abortedProjectsRef.current.has(crawlingProject.id) || pauseRequestedRef.current.has(crawlingProject.id) || isStaleGen()) {
          console.log(`[Process] Crawling project ${crawlingProject.id} was aborted/paused/reset during processing, not saving results`);
          return;
        }

        recordActivity(crawlingProject.id, results.map((r: { url: string; error: string | null }) => ({
          url: r.url,
          ok: !r.error,
          message: r.error || undefined,
          timestamp: Date.now(),
        })));

        let progressVersion: number | undefined;
        try {
          // Only drop depths for URLs the server actually processed; untrimmed
          // URLs stay in the queue with their depth intact.
          processedAppend.forEach((u: string) => { delete newCrawlDepths[u]; });

          // Stats are updated incrementally — the client no longer holds the
          // full results array, so totals are prior stats + this batch's delta.
          const batchImages = resultsAppend.reduce((acc, curr) => acc + (curr.images?.length || 0), 0);
          const batchVideos = resultsAppend.reduce((acc, curr) => acc + (curr.videos?.length || 0), 0);

          const progressRes = await apiRequest('POST', `/api/projects/${crawlingProject.id}/crawl-progress`, {
            lockOwner: TAB_ID,
            expectedVersion: crawlState.version,
            queue: newQueue,
            crawlDepths: newCrawlDepths,
            processedAppend,
            resultsAppend,
            errorsAppend,
            stats: {
              ...(crawlState.stats || {}),
              totalUrls: priorResultCount + resultsAppend.length,
              totalImages: (crawlState.stats?.totalImages || 0) + batchImages,
              totalVideos: (crawlState.stats?.totalVideos || 0) + batchVideos,
            },
          });
          const progressData = await progressRes.json();
          progressVersion = progressData?.version;
          queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
          // Self-schedule the next batch with the project's own delay so
          // parallel projects each keep their configured pace.
          scheduleProjectKick(crawlingProject.id, Math.max(
            MIN_BATCH_DELAY_MS,
            crawlState.projectSettings?.scraping?.delayMs ?? 800,
          ));
        } catch (err) {
          if (isConflictError(err)) {
            handleWriteConflict(crawlingProject.id);
            return;
          }
          throw err;
        }

        // Auto-rollback when the server signals throttling — done AFTER the
        // progress write so the rollback mutation doesn't conflict with it.
        // All calculations are based on freshly fetched project settings so
        // concurrent user changes are never overwritten.
        if (rateLimitDetected) {
          // Must fetch fresh state: using stale settings would CAS-succeed but
          // silently overwrite any settings the user changed during the
          // in-flight request. Use the lightweight crawl-state endpoint.
          let freshVersion: number | undefined;
          let freshSettings: ProjectSettingsType | undefined;
          try {
            const freshRes = await apiRequest('GET', `/api/projects/${crawlingProject.id}/crawl-state`);
            const freshProject = await freshRes.json();
            freshVersion = freshProject.version;
            freshSettings = freshProject.projectSettings ?? undefined;
          } catch {
            // If refetch fails we cannot safely CAS — skip rollback entirely
            // to avoid clobbering unknown concurrent changes.
          }

          if (freshVersion !== undefined && freshSettings !== undefined) {
            const currentParallel = freshSettings?.scraping?.parallelRequests ?? 10;
            const rolledBackTo = suggestedParallelRequests ?? Math.max(1, Math.floor(currentParallel / 2));
            if (rolledBackTo < currentParallel) {
              console.warn(`[RateLimit/Crawl] Rolling back parallelRequests from ${currentParallel} to ${rolledBackTo}`);
              const newSettings = {
                ...freshSettings,
                scraping: {
                  ...freshSettings.scraping,
                  parallelRequests: rolledBackTo,
                },
              };
              let rollbackPersisted = false;
              try {
                await updateProjectMutation.mutateAsync({
                  id: crawlingProject.id,
                  expectedVersion: freshVersion,
                  updates: { projectSettings: newSettings as any },
                });
                rollbackPersisted = true;
              } catch (rollbackErr) {
                if (!isConflictError(rollbackErr)) {
                  console.error('[RateLimit/Crawl] Failed to persist parallelRequests rollback:', rollbackErr);
                }
                // On conflict another tab already updated settings — skip modal
              }
              if (rollbackPersisted) setRateLimitModal({
                open: true,
                projectId: crawlingProject.id,
                fromValue: currentParallel,
                toValue: rolledBackTo,
                customValue: rolledBackTo,
              });
            }
          }
        }
      } finally {
        lastActivityRef.current.set(crawlingProject.id, Date.now());
      }
      return;
    }

    const contentScrapingProject = project.status === 'content_scraping' ? project : null;
    if (contentScrapingProject) {
      // Check if project was marked for deletion - stop immediately
      if (abortedProjectsRef.current.has(contentScrapingProject.id)) {
        console.log(`[Process] Content scraping project ${contentScrapingProject.id} was aborted, skipping`);
        contentQueueRef.current.delete(contentScrapingProject.id);
        return;
      }
      // Another tab is actively processing this project - don't take over
      if (isLockedByOtherTab(contentScrapingProject)) {
        notifyLockedByOtherTab(contentScrapingProject.id);
        return;
      }
      
      // Initialize this project's queue entry if not set yet
      if (!contentQueueRef.current.has(contentScrapingProject.id)) {
        contentQueueRef.current.set(contentScrapingProject.id, [...(contentScrapingProject.queue || [])]);
        console.log(`[ProcessStep] Initialized queue ref for project ${contentScrapingProject.id} with ${contentQueueRef.current.get(contentScrapingProject.id)!.length} URLs`);
      }

      // Use the ref queue, not the stale project queue
      const currentQueue = contentQueueRef.current.get(contentScrapingProject.id)!;

      if (currentQueue.length === 0) {
        contentQueueRef.current.delete(contentScrapingProject.id);
        await updateProjectMutation.mutateAsync({ 
          id: contentScrapingProject.id, 
          updates: { 
            status: 'idle',
            queue: [],
            stats: { ...contentScrapingProject.stats!, endTime: Date.now() }
          } 
        });
        // Auto-run image dedup now that content extraction is complete.
        triggerImageDedupAsync(contentScrapingProject.id);
        return;
      }

      lastActivityRef.current.set(contentScrapingProject.id, Date.now());

      // Read settings fresh each batch so in-flight setting changes take effect
      const contentBatchSize = Math.min(
        Math.max(1, contentScrapingProject.projectSettings?.scraping?.parallelRequests ?? 10),
        MAX_BATCH_SIZE,
      );
      const contentDelayMs = Math.max(
        MIN_BATCH_DELAY_MS,
        contentScrapingProject.projectSettings?.scraping?.delayMs ?? 1000,
      );

      const batchUrls = currentQueue.slice(0, contentBatchSize);
      const remainingQueue = currentQueue.slice(contentBatchSize);
      
      // Update ref immediately - this is the source of truth for next batch
      contentQueueRef.current.set(contentScrapingProject.id, remainingQueue);

      // Helper to schedule next batch - centralized logic
      const scheduleNextBatch = (queueLength: number) => {
        lastActivityRef.current.set(contentScrapingProject.id, Date.now());
        if (queueLength > 0) {
          console.log(`[ProcessStep] Scheduling next batch in ${contentDelayMs}ms, ${queueLength} remaining`);
          scheduleProjectKick(contentScrapingProject.id, contentDelayMs);
        } else {
          console.log('[ProcessStep] Queue empty, extraction complete');
          contentQueueRef.current.delete(contentScrapingProject.id);
          // Kick once more so the queue-empty branch flips the project to idle.
          scheduleProjectKick(contentScrapingProject.id, MIN_BATCH_DELAY_MS);
        }
      };

      try {
        // Send projectId so server saves scrapedData directly to DB
        console.log(`[ProcessStep] Starting batch of ${batchUrls.length} URLs, ${remainingQueue.length} remaining`);
        let res;
        try {
          res = await apiRequest('POST', '/api/scrape/content', { 
            urls: batchUrls, 
            projectId: contentScrapingProject.id,
            lockOwner: TAB_ID,
          });
        } catch (err) {
          if (isConflictError(err)) {
            // Another tab owns the extraction - discard and stop this tab's loop
            handleWriteConflict(contentScrapingProject.id);
            contentQueueRef.current.delete(contentScrapingProject.id);
            return;
          }
          throw err;
        }
        const batchResponse = await res.json();
        const { results, version: batchVersion, rateLimitDetected, suggestedParallelRequests } = batchResponse;
        console.log(`[ProcessStep] Batch completed, ${results.length} results${rateLimitDetected ? ' [RATE LIMITED]' : ''}`);

        // Server saves scrapedData directly - we only track errors and stats
        let newErrors = [...(contentScrapingProject.errors || [])];
        let scrapedInBatch = 0;

        results.forEach((r: { url: string; success: boolean; error: string | null }) => {
          if (r.success) {
            scrapedInBatch++;
          } else if (r.error) {
            newErrors.push({ 
              url: r.url, 
              message: "Extract Error: " + r.error, 
              timestamp: new Date().toISOString() 
            });
          }
        });

        // Check if pause/stop was requested during the API call - don't persist
        // past the boundary and don't schedule the next batch
        if (pauseRequestedRef.current.has(contentScrapingProject.id)) {
          console.log(`[Process] Content scraping project ${contentScrapingProject.id} was paused/stopped during processing, not saving batch`);
          contentQueueRef.current.delete(contentScrapingProject.id);
          return;
        }
        // Check again if project was aborted or externally reset during API call
        if (abortedProjectsRef.current.has(contentScrapingProject.id) || isStaleGen()) {
          console.log(`[Process] Content scraping project ${contentScrapingProject.id} was aborted/reset during processing, not saving results`);
          if (!isStaleGen()) contentQueueRef.current.delete(contentScrapingProject.id);
          // Don't schedule next batch - project was aborted/reset
          return;
        }

        recordActivity(contentScrapingProject.id, results.map((r: { url: string; success: boolean; error: string | null }) => ({
          url: r.url,
          ok: !!r.success,
          message: r.error || undefined,
          timestamp: Date.now(),
        })));

        // Only update queue, errors and stats - NOT results (server handles that)
        const updatedProject = {
          ...contentScrapingProject,
          queue: remainingQueue,
          errors: newErrors,
          stats: {
            ...contentScrapingProject.stats!,
            scrapedPages: (contentScrapingProject.stats?.scrapedPages || 0) + scrapedInBatch,
          },
        };
        
        try {
          await updateProjectMutation.mutateAsync({
            id: contentScrapingProject.id,
            // CAS against the version produced by the guarded batch write above
            expectedVersion: typeof batchVersion === 'number' ? batchVersion : undefined,
            updates: {
              queue: remainingQueue,
              errors: newErrors,
              stats: updatedProject.stats,
            },
          });
          
          // Update caches for UI display. IMPORTANT: merge into the existing
          // cache entries instead of replacing them. `contentScrapingProject`
          // comes from the "lite" list endpoint (no results/scrapedData/
          // scrapedCount) - writing it into the detail cache wholesale made
          // the Scraped counter flash to 0 and the results list disappear
          // until the next refetch.
          queryClient.setQueryData(['/api/projects'], (old: Project[] | undefined) => {
            if (!old) return old;
            return old.map(p => p.id === contentScrapingProject.id
              ? { ...p, queue: remainingQueue, errors: newErrors, stats: updatedProject.stats }
              : p);
          });
          // Scraped counts are NOT touched here: the mutation's invalidation
          // refetches list + detail, and those carry the server-authoritative
          // counts/result flags. Adding a local delta on top would double-count.
          queryClient.setQueryData(['/api/projects', contentScrapingProject.id], (old: Project | undefined) => {
            if (!old) return old;
            return { ...old, queue: remainingQueue, errors: newErrors, stats: updatedProject.stats };
          });
        } catch (updateErr) {
          if (isConflictError(updateErr)) {
            handleWriteConflict(contentScrapingProject.id);
            contentQueueRef.current.delete(contentScrapingProject.id);
            return;
          }
          console.error('[ProcessStep] Failed to save batch results:', updateErr);
        }
        
        // Auto-rollback when the server signals throttling — done AFTER the
        // queue/stats write so the rollback mutation doesn't invalidate batchVersion.
        // Uses no expectedVersion (settings are not progress-critical) so it
        // can never conflict with the batch CAS above.
        if (rateLimitDetected) {
          const currentParallel = contentScrapingProject.projectSettings?.scraping?.parallelRequests ?? 10;
          const rolledBackTo = suggestedParallelRequests ?? Math.max(1, Math.floor(currentParallel / 2));
          if (rolledBackTo < currentParallel) {
            console.warn(`[RateLimit] Rolling back parallelRequests from ${currentParallel} to ${rolledBackTo}`);
            const newSettings = {
              ...(contentScrapingProject.projectSettings ?? {}),
              scraping: {
                ...(contentScrapingProject.projectSettings?.scraping ?? {}),
                parallelRequests: rolledBackTo,
              },
            };
            let rollbackPersisted = false;
            try {
              await updateProjectMutation.mutateAsync({
                id: contentScrapingProject.id,
                // No expectedVersion — settings rollback must not conflict with
                // the batch progress write that just succeeded above.
                updates: { projectSettings: newSettings as any },
              });
              rollbackPersisted = true;
            } catch (rollbackErr) {
              console.error('[RateLimit] Failed to persist parallelRequests rollback:', rollbackErr);
            }
            if (rollbackPersisted) setRateLimitModal({
              open: true,
              projectId: contentScrapingProject.id,
              fromValue: currentParallel,
              toValue: rolledBackTo,
              customValue: rolledBackTo,
            });
          }
        }

        // Always schedule next batch regardless of mutation success
        scheduleNextBatch(remainingQueue.length);
      } catch (err) {
        // On network/API error, still update queue to skip failed batch and continue
        console.error('[ProcessStep] Content scraping batch error:', {
          error: err,
          message: err instanceof Error ? err.message : 'Unknown',
          batchSize: batchUrls.length,
          remainingCount: remainingQueue.length
        });
        const errorMessage = err instanceof Error ? err.message : 'Unknown batch error';
        const batchErrors = batchUrls.map(url => ({
          url,
          message: `Batch Error: ${errorMessage}`,
          timestamp: new Date().toISOString()
        }));
        
        const updatedErrorProject = {
          ...contentScrapingProject,
          queue: remainingQueue,
          errors: [...(contentScrapingProject.errors || []), ...batchErrors],
        };
        
        try {
          await updateProjectMutation.mutateAsync({
            id: contentScrapingProject.id,
            updates: {
              queue: remainingQueue,
              errors: updatedErrorProject.errors,
            },
          });
          
          // Merge into caches (see note above - never overwrite the detail
          // cache with a lite list object)
          queryClient.setQueryData(['/api/projects'], (old: Project[] | undefined) => {
            if (!old) return old;
            return old.map(p => p.id === contentScrapingProject.id
              ? { ...p, queue: remainingQueue, errors: updatedErrorProject.errors }
              : p);
          });
          queryClient.setQueryData(['/api/projects', contentScrapingProject.id], (old: Project | undefined) => {
            if (!old) return old;
            return { ...old, queue: remainingQueue, errors: updatedErrorProject.errors };
          });
        } catch (updateErr) {
          if (isConflictError(updateErr)) {
            handleWriteConflict(contentScrapingProject.id);
            contentQueueRef.current.delete(contentScrapingProject.id);
            return;
          }
          console.error('[ProcessStep] Failed to update queue after batch error:', updateErr);
        }
        
        // Always schedule next batch even after error
        scheduleNextBatch(remainingQueue.length);
      }
    }
  }, [updateProjectMutation, recordActivity, notifyLockedByOtherTab, handleWriteConflict, setRateLimitModal, scheduleProjectKick, toast, t]);

  // Dispatcher: starts one batch per eligible active project, up to
  // MAX_PARALLEL_PROJECTS concurrently. Per-project mutual exclusion is
  // guaranteed by adding the ID to processingProjectsRef synchronously
  // BEFORE the async step starts.
  const processStep = useCallback(async () => {
    // Stale loop from a previous mount/hot-update? Stop silently.
    if (loopGenRef.current !== scrapeLoopGeneration) {
      console.log('[Process] Stale loop generation detected, stopping this loop');
      return;
    }
    const running = processingProjectsRef.current;
    // Fair admission: serve the least-recently-dispatched project first so a
    // fourth (or later) active project is never starved by list order while
    // the first three keep re-dispatching themselves.
    const actives = activeProjectsForDispatch(queryClient, projects)
      .sort((a, b) =>
        (lastDispatchedAtRef.current.get(a.id) ?? 0) - (lastDispatchedAtRef.current.get(b.id) ?? 0)
      );
    for (const project of actives) {
      if (running.size >= MAX_PARALLEL_PROJECTS) break;
      if (running.has(project.id)) continue;
      if (abortedProjectsRef.current.has(project.id)) continue;
      // Respect the project's own delay between batches. If it isn't
      // eligible yet, make sure a kick timer exists so it resumes on time.
      const wait = (nextEligibleAtRef.current.get(project.id) ?? 0) - Date.now();
      if (wait > 0) {
        if (!pendingKickRef.current.has(project.id)) {
          const timer = setTimeout(() => {
            pendingKickRef.current.delete(project.id);
            processStepRef.current().catch(err => {
              console.error('[Process] Step failed, will retry:', err);
            });
          }, wait);
          pendingKickRef.current.set(project.id, timer);
        }
        continue;
      }
      running.add(project.id);
      lastActivityRef.current.set(project.id, Date.now());
      lastDispatchedAtRef.current.set(project.id, Date.now());
      const gen = stepGenRef.current.get(project.id) ?? 0;
      processProjectStep(project, gen)
        .catch(err => {
          console.error(`[Process] Step failed for project ${project.id}, will retry:`, err);
        })
        .finally(() => {
          running.delete(project.id);
          // Never immediately recurse on a stale render after completion or
          // failure. That cancels in-flight refetches over and over and can
          // repeatedly finish the same project (including expensive dedup).
          scheduleAfterStep(project.id, pendingKickRef.current, scheduleProjectKick, MIN_BATCH_DELAY_MS);
        });
    }
  }, [projects, processProjectStep, scheduleProjectKick]);
  // Keep ref current every render so setTimeout callbacks inside processStep
  // always invoke the latest closure (with fresh projects/settings state).
  processStepRef.current = processStep;

  // Reset a stuck project's processing slot if genuinely stuck
  // (no activity for that project for 120 seconds)
  useEffect(() => {
    const checkInterval = setInterval(() => {
      const now = Date.now();
      for (const projectId of Array.from(processingProjectsRef.current)) {
        const lastActivity = lastActivityRef.current.get(projectId) ?? 0;
        if (now - lastActivity > 120000) { // 120 seconds of no activity
          console.warn(`Resetting stuck processing slot for project ${projectId} after 120s inactivity`);
          // Bump the generation so the hung step (if it ever resumes) discards
          // its results instead of persisting alongside a newly dispatched one.
          stepGenRef.current.set(projectId, (stepGenRef.current.get(projectId) ?? 0) + 1);
          processingProjectsRef.current.delete(projectId);
        }
      }
    }, 10000); // Check every 10 seconds
    return () => clearInterval(checkInterval);
  }, []);

  useEffect(() => {
    const hasEligible = projects.some(
      p => (p.status === 'scraping' || p.status === 'content_scraping' || p.status === 'crawling')
        && !processingProjectsRef.current.has(p.id)
    );
    if (hasEligible) {
      // Per-project delays (settings.delayMs) are enforced inside the
      // dispatcher via nextEligibleAtRef, so this effect only needs a short
      // debounce before dispatching.
      // Never let a transient request failure (e.g. 502 during a server
      // restart) escape as an unhandled rejection — log and retry next tick.
      const timer = setTimeout(() => {
        processStep().catch(err => {
          console.error('[Process] Step failed, will retry:', err);
        });
      }, MIN_BATCH_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [projects, processStep]);

  // While another tab owns the scrape lock, poll periodically so this tab
  // notices an expired lock (e.g. the owning tab was closed) without needing
  // window focus, and seamlessly takes over processing.
  // Poll every 30 s while the lock is still valid; speed up to 5 s once the
  // client-side TTL shows the lock has expired so the gap between expiry and
  // automatic takeover stays short.
  useEffect(() => {
    const lockedActives = projects.filter(
      p => (p.status === 'scraping' || p.status === 'content_scraping' || p.status === 'crawling')
        && isLockedByOtherTab(p)
    );
    if (lockedActives.length === 0) return;
    const anyExpiredClientSide = lockedActives.some(
      p => ((p.scrapeLock as any)?.expiresAt ?? 0) < Date.now()
    );
    const pollMs = anyExpiredClientSide ? 5000 : 30000;
    const timer = setInterval(async () => {
      const result = await refetchProjects();
      const lockedIds = new Set(lockedActives.map(p => p.id));
      const takeoverReady = result.data?.some(fresh =>
        lockedIds.has(fresh.id) &&
        (fresh.status === 'scraping' || fresh.status === 'content_scraping' || fresh.status === 'crawling') &&
        !isLockedByOtherTab(fresh) &&
        !processingProjectsRef.current.has(fresh.id)
      );
      if (takeoverReady) {
        console.log('[Process] A lock expired, taking over processing');
        result.data?.forEach(fresh => {
          if (lockedIds.has(fresh.id) && !isLockedByOtherTab(fresh)) {
            lockNotifiedRef.current.delete(fresh.id);
          }
        });
        processStep().catch(err => {
          console.error('[Process] Step failed, will retry:', err);
        });
      }
    }, pollMs);
    return () => clearInterval(timer);
  }, [projects, refetchProjects, processStep]);

  // When the detail view is open and the active project's lock is held by
  // another tab, schedule a one-shot timer that fires the moment the lock TTL
  // elapses.  The state bump forces a re-render so `isLockedByOtherTab` (which
  // calls Date.now() inline) re-evaluates to false and the banner disappears
  // automatically — without waiting for the next manual refetch or poll cycle.
  const [, setLockExpiredTick] = useState(0);
  useEffect(() => {
    if (!activeProject) return;
    const lock = activeProject.scrapeLock as { owner: string; expiresAt: number } | null | undefined;
    if (!lock || lock.owner === TAB_ID) return;
    const msUntilExpiry = lock.expiresAt - Date.now();
    if (msUntilExpiry <= 0) return; // already expired — banner already hidden
    const timer = setTimeout(() => {
      setLockExpiredTick(n => n + 1);
    }, msUntilExpiry);
    return () => clearTimeout(timer);
  }, [activeProject]);

  const [isStartingExtraction, setIsStartingExtraction] = useState(false);
  const startContentScrape = useCallback(async () => {
    if (!activeProject || isStartingExtraction) return;
    
    console.log(`[StartExtraction] Starting extraction for project ${activeProject.id}`);
    setIsStartingExtraction(true);
    
    // Cancel any in-flight step for this project and clear its scheduling
    // state so the extraction loop starts fresh (slot is released by the old
    // step's .finally()).
    clearProjectScheduling(activeProject.id);

    try {
      // Use dedicated server endpoint that calculates URLs server-side
      const res = await apiRequest('POST', `/api/projects/${activeProject.id}/start-extraction`, { lockOwner: TAB_ID });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || 'Failed to start extraction');
      }
      
      // Invalidate cache and refetch to trigger processing loop
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      await refetchProjects();
      console.log('[StartExtraction] Project updated and refetched, loop should start');
    } catch (err) {
      console.error('[StartExtraction] Failed to start extraction:', err);
      toast({ 
        title: t('error'), 
        description: err instanceof Error ? err.message : 'Failed to start extraction', 
        variant: 'destructive' 
      });
    } finally {
      // Once the project refetches into an active-process status, this
      // section unmounts entirely; resetting here only matters for the
      // failure path where the button reappears.
      setIsStartingExtraction(false);
    }
  }, [activeProject, isStartingExtraction, toast, t, refetchProjects, clearProjectScheduling]);

  // Incremental update: re-discover URLs, then scrape only new/changed pages
  const startUpdate = useCallback(async (projectId: number) => {
    // Cancel any in-flight step and clear scheduling state (slot is released
    // by the old step's .finally()).
    clearProjectScheduling(projectId);
    try {
      const res = await apiRequest('POST', `/api/projects/${projectId}/start-update`, { lockOwner: TAB_ID });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || 'Failed to start update');
      }
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      await refetchProjects();
      if (data.mode === 'crawl') {
        toast({ title: t('updateStarted'), description: t('updateCrawlStarted') });
      } else if (data.summary) {
        const s = data.summary;
        const total = s.newUrls + s.changedUrls + s.removedUrls;
        toast({
          title: t('updateStarted'),
          description: total === 0
            ? t('updateNoChanges')
            : `${s.newUrls} ${t('updateSummaryNew')}, ${s.changedUrls} ${t('updateSummaryChanged')}, ${s.removedUrls} ${t('updateSummaryRemoved')}`,
        });
      }
    } catch (err) {
      toast({
        title: t('error'),
        description: err instanceof Error ? err.message : 'Failed to start update',
        variant: 'destructive',
      });
    }
  }, [toast, t, refetchProjects, clearProjectScheduling]);

  const [isSyncingErrors, setIsSyncingErrors] = useState(false);
  const [processAction, setProcessAction] = useState<'pause' | 'resume' | 'stop' | null>(null);
  const syncErrors = useCallback(async () => {
    if (!activeProject) return;
    
    setIsSyncingErrors(true);
    try {
      const res = await apiRequest('POST', `/api/projects/${activeProject.id}/sync-errors`, { lockOwner: TAB_ID });
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.message || 'Failed to sync errors');
      }
      
      // Refetch projects to update UI
      queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
      await refetchProjects();
      
      toast({ 
        title: 'Errors synced', 
        description: `${data.synced} error URLs marked as failed` 
      });
    } catch (err) {
      console.error('[SyncErrors] Failed:', err);
      toast({ 
        title: t('error'), 
        description: err instanceof Error ? err.message : 'Failed to sync errors', 
        variant: 'destructive' 
      });
    } finally {
      setIsSyncingErrors(false);
    }
  }, [activeProject, toast, t, refetchProjects, clearProjectScheduling]);

  const stopProcess = useCallback(async () => {
    if (!activeProject || processAction) return;
    setProcessAction('stop');
    pauseRequestedRef.current.add(activeProject.id);
    try {
      await updateProjectMutation.mutateAsync({
        id: activeProject.id,
        updates: { status: 'idle', queue: [] },
      });
    } finally {
      setProcessAction(null);
    }
  }, [activeProject, updateProjectMutation, processAction]);

  const pauseProcess = useCallback(async () => {
    if (!activeProject || processAction) return;
    setProcessAction('pause');
    pauseRequestedRef.current.add(activeProject.id);
    const currentStatus = activeProject.status;
    try {
      if (currentStatus === 'content_scraping') {
        await updateProjectMutation.mutateAsync({
          id: activeProject.id,
          updates: { status: 'content_paused' },
        });
      } else if (currentStatus === 'scraping') {
        await updateProjectMutation.mutateAsync({
          id: activeProject.id,
          updates: { status: 'paused' },
        });
      } else if (currentStatus === 'crawling') {
        await updateProjectMutation.mutateAsync({
          id: activeProject.id,
          updates: { status: 'crawl_paused' },
        });
      }
    } finally {
      setProcessAction(null);
    }
  }, [activeProject, updateProjectMutation, processAction]);

  const resumeProcess = useCallback(async () => {
    if (!activeProject || processAction) return;
    setProcessAction('resume');
    pauseRequestedRef.current.delete(activeProject.id);
    const currentStatus = activeProject.status;
    try {
      if (currentStatus === 'content_paused') {
        await updateProjectMutation.mutateAsync({
          id: activeProject.id,
          updates: { status: 'content_scraping' },
        });
      } else if (currentStatus === 'paused') {
        await updateProjectMutation.mutateAsync({
          id: activeProject.id,
          updates: { status: 'scraping' },
        });
      } else if (currentStatus === 'crawl_paused') {
        await updateProjectMutation.mutateAsync({
          id: activeProject.id,
          updates: { status: 'crawling' },
        });
      }
    } finally {
      setProcessAction(null);
    }
  }, [activeProject, updateProjectMutation, processAction]);

  // The project detail query is intentionally lite (no results array) so
  // opening a huge project stays fast; a full export is an explicit,
  // infrequent action, so it's fine to fetch the full payload on demand here.
  const [isExportingProject, setIsExportingProject] = useState(false);
  const exportProject = useCallback(async () => {
    if (!activeProject) return;
    setIsExportingProject(true);
    try {
      const res = await apiRequest('GET', `/api/projects/${activeProject.id}/export`);
      const fullProject = await res.json();
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(fullProject, null, 2));
      const a = document.createElement('a');
      a.href = dataStr;
      a.download = `${(activeProject.displayName || activeProject.domain).replace(/[^a-z0-9]/gi, '_')}-export.json`;
      a.click();
    } catch (error) {
      toast({ title: t('error'), variant: 'destructive' });
    } finally {
      setIsExportingProject(false);
    }
  }, [activeProject, t, toast]);

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
    if (activeProject.status === 'scraping' || activeProject.status === 'paused' ||
        activeProject.status === 'crawling' || activeProject.status === 'crawl_paused') {
      const total = (activeProject.processed?.length || 0) + (activeProject.queue?.length || 0);
      return total === 0 ? 0 : Math.min(100, Math.round(((activeProject.processed?.length || 0) / total) * 100));
    }
    if (activeProject.status === 'content_scraping' || activeProject.status === 'content_paused') {
      // Use queue-based calculation: progress = (total - remaining) / total
      // Use contentQueueRef for live updates during active processing
      const total = (activeProject as any)?.urlCount ?? (activeProject.results || []).length;
      const remaining = contentQueueRef.current.get(activeProject.id)?.length
        ?? (activeProject.queue?.length || 0);
      const processed = total - remaining;
      return total === 0 ? 0 : Math.min(100, Math.round((processed / total) * 100));
    }
    return 0;
  }, [activeProject]);

  const isProcessing = activeProject?.status === 'scraping' || activeProject?.status === 'content_scraping' || activeProject?.status === 'crawling';
  const isPaused = activeProject?.status === 'paused' || activeProject?.status === 'content_paused' || activeProject?.status === 'crawl_paused';
  const hasActiveProcess = isProcessing || isPaused;
  // Use contentQueueRef for live updates during active processing, fallback to project queue
  const remainingUrls = (activeProject?.status === 'content_scraping'
    ? contentQueueRef.current.get(activeProject.id)?.length
    : undefined) ?? (activeProject?.queue?.length || 0);
  // Use the dedicated (always-fresh, whole-dataset) summary query first, then
  // fall back to whatever counts came back with the project detail payload,
  // then to a client-side count over the (lite) results array if present.
  const scrapedCount = resultsSummary?.scrapedCount ?? (activeProject as any)?.scrapedCount ?? (activeProject?.results || []).filter(r => r.scrapedData || r.hasScrapedData).length;
  const failedCount = resultsSummary?.failedCount ?? (activeProject as any)?.failedCount ?? (activeProject?.results || []).filter((r: any) => r.errorStatus === 'failed' || r.errorStatus === 'skipped').length;
  const urlCount = resultsSummary?.urlCount ?? (activeProject as any)?.urlCount ?? (activeProject?.results || []).length;
  // During active processing, use queue length as source of truth for pending
  // Otherwise use math-based calculation (more accurate for completed projects)
  const isActivelyProcessing = activeProject?.status === 'content_scraping' || activeProject?.status === 'content_paused';
  const pendingContentScrape = isActivelyProcessing ? remainingUrls : Math.max(0, urlCount - scrapedCount - failedCount);
  const attachmentCount = resultsSummary?.attachmentCount ?? (activeProject?.results || []).reduce((sum, r: any) => {
    return sum + (r.pdfCount || 0);
  }, 0);
  const errorsArrayCount = (activeProject?.errors || []).length;
  const hasUnsyncedErrors = errorsArrayCount > 0 && pendingContentScrape > 0;

  // Live rate / ETA from the current session (since page load / process start)
  const liveRateStats = useMemo(() => {
    const projectStats = activeProject?.id != null ? sessionStats[activeProject.id] : undefined;
    if (!projectStats) {
      return { pagesPerMinute: null as number | null, etaMs: null as number | null };
    }
    const elapsedMs = Date.now() - projectStats.startTime;
    // Need a few seconds of data before the rate is meaningful
    if (elapsedMs < 5000 || projectStats.processedCount === 0) {
      return { pagesPerMinute: null, etaMs: null };
    }
    const pagesPerMinute = projectStats.processedCount / (elapsedMs / 60000);
    // During crawl discovery the queue keeps growing, so a completion ETA would
    // be misleading - suppress it and only show the processing rate.
    const isCrawlDiscovery = activeProject?.status === 'crawling' || activeProject?.status === 'crawl_paused';
    const etaMs = !isCrawlDiscovery && pagesPerMinute > 0 && remainingUrls > 0
      ? (remainingUrls / pagesPerMinute) * 60000
      : null;
    return { pagesPerMinute, etaMs };
    // sessionStats changes with every recorded batch, which keeps this fresh
  }, [sessionStats, activeProject?.id, activeProject?.status, remainingUrls]);

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
        onNavigate={(view) => {
          if (view === 'converter') {
            navigate('/converter');
          } else {
            setActiveProjectId(null);
          }
        }}
        onImport={() => fileInputRef.current?.click()}
        t={t}
      />
      
      <div className="flex-1 flex flex-col min-w-0">
        <Header 
          title={activeProject ? (activeProject.displayName || activeProject.domain) : 'Dashboard'}
          subtitle={activeProject ? `${urlCount.toLocaleString()} URLs` : undefined}
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
                      onUpdate={() => startUpdate(project.id)}
                      isLockedByOtherTab={isLockedByOtherTab(project)}
                      onTakeLock={() => takeLock(project.id)}
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
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-foreground">{t('singlePages')}</h2>
                  {singlePages.length > 0 && (
                    <div className="flex items-center gap-2">
                      {selectionMode && selectedSinglePages.size > 0 && (
                        <Button
                          variant="default"
                          size="sm"
                          className="gap-2"
                          onClick={() => setConvertDialog({ open: true, projectName: '', deleteSinglePages: false })}
                          data-testid="button-convert-to-project"
                        >
                          <FolderPlus className="w-4 h-4" />
                          {t('convertToProject')} ({selectedSinglePages.size})
                        </Button>
                      )}
                      <Button
                        variant={selectionMode ? 'secondary' : 'outline'}
                        size="sm"
                        className="gap-2"
                        onClick={() => {
                          setSelectionMode(!selectionMode);
                          if (selectionMode) setSelectedSinglePages(new Set());
                        }}
                        data-testid="button-toggle-selection"
                      >
                        <CheckSquare className="w-4 h-4" />
                        {selectionMode ? t('cancelSelection') : t('selectPages')}
                      </Button>
                    </div>
                  )}
                </div>
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
                  <>
                    {selectionMode && singlePages.filter(p => p.status === 'completed').length > 1 && (
                      <div className="flex items-center gap-3 mb-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const completedIds = singlePages.filter(p => p.status === 'completed').map(p => p.id);
                            setSelectedSinglePages(new Set(completedIds));
                          }}
                          data-testid="button-select-all"
                        >
                          {t('selectAll')}
                        </Button>
                        {selectedSinglePages.size > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedSinglePages(new Set())}
                            data-testid="button-deselect-all"
                          >
                            {t('deselectAll')}
                          </Button>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {selectedSinglePages.size} {t('selected')}
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                      {singlePages.map(page => {
                        const isSelected = selectedSinglePages.has(page.id);
                        const isCompleted = page.status === 'completed';
                        return (
                          <div 
                            key={page.id} 
                            className={`bg-card border rounded-lg p-4 hover-elevate cursor-pointer ${isSelected ? 'border-primary ring-1 ring-primary/30' : 'border-border'}`}
                            data-testid={`single-page-card-${page.id}`}
                            onClick={() => {
                              if (selectionMode && isCompleted) {
                                setSelectedSinglePages(prev => {
                                  const next = new Set(prev);
                                  if (next.has(page.id)) next.delete(page.id);
                                  else next.add(page.id);
                                  return next;
                                });
                              } else {
                                navigate(`/single-page/${page.id}`);
                              }
                            }}
                          >
                            <div className="flex items-start gap-3">
                              {selectionMode ? (
                                <div className="shrink-0 mt-0.5">
                                  <Checkbox
                                    checked={isSelected}
                                    disabled={!isCompleted}
                                    onCheckedChange={() => {
                                      if (!isCompleted) return;
                                      setSelectedSinglePages(prev => {
                                        const next = new Set(prev);
                                        if (next.has(page.id)) next.delete(page.id);
                                        else next.add(page.id);
                                        return next;
                                      });
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    data-testid={`checkbox-single-page-${page.id}`}
                                  />
                                </div>
                              ) : (
                                <div className="shrink-0 mt-0.5">
                                  <FileText className="w-4 h-4 text-muted-foreground" />
                                </div>
                              )}
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
                              {!selectionMode && (
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRenameSinglePage({
                                        open: true,
                                        pageId: page.id,
                                        currentTitle: page.title || page.url,
                                        newTitle: page.title || '',
                                      });
                                    }}
                                    data-testid={`rename-single-page-${page.id}`}
                                  >
                                    <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setDeleteSinglePageConfirm({
                                        open: true,
                                        pageId: page.id,
                                        pageName: page.title || page.url,
                                      });
                                    }}
                                    data-testid={`delete-single-page-${page.id}`}
                                  >
                                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : !activeProject ? (
            <div className="flex items-center justify-center py-24" data-testid="project-loading">
              <div className="text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-primary" />
                <p className="text-sm text-muted-foreground">{t('loading')}</p>
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
                          if (!activeProject) return;
                          setAttachmentSync({ active: true, processed: 0, total: 0, pdfsFound: 0, directPdfs: 0, errors: 0, done: false });
                          const es = new EventSource(`/api/projects/${activeProject.id}/sync-attachments?lockOwner=${encodeURIComponent(TAB_ID)}`);
                          es.addEventListener('init', (e) => {
                            const data = JSON.parse(e.data);
                            setAttachmentSync(prev => prev ? { ...prev, total: data.totalHtmlPages, directPdfs: data.directPdfUrls } : prev);
                          });
                          es.addEventListener('progress', (e) => {
                            const data = JSON.parse(e.data);
                            setAttachmentSync(prev => prev ? { ...prev, processed: data.processed, pdfsFound: data.pdfsFound, errors: data.errors } : prev);
                          });
                          es.addEventListener('complete', (e) => {
                            const data = JSON.parse(e.data);
                            setAttachmentSync(prev => prev ? { ...prev, processed: prev.total, pdfsFound: data.pdfsFound, directPdfs: data.directPdfs, errors: data.errors, done: true } : prev);
                            queryClient.invalidateQueries({ queryKey: ['/api/projects'] });
                            es.close();
                          });
                          es.addEventListener('sync-error', (e) => {
                            const data = JSON.parse(e.data);
                            setAttachmentSync(prev => prev ? { ...prev, done: true } : prev);
                            toast({ title: t('syncAttachmentsError'), description: data.message, variant: 'destructive' });
                            es.close();
                          });
                          es.onerror = () => {
                            if (es.readyState === EventSource.CLOSED) return;
                            setAttachmentSync(prev => prev ? { ...prev, done: true } : prev);
                            toast({ title: t('syncAttachmentsError'), variant: 'destructive' });
                            es.close();
                          };
                        }}
                        className="gap-2"
                        disabled={attachmentSync?.active && !attachmentSync?.done}
                        data-testid="button-sync-attachments"
                      >
                        <Paperclip className="w-4 h-4" />
                        {t('syncAttachments')}
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => {
                          if (scrapedCount === 0) {
                            toast({ title: t('deepScrapingRequired'), variant: 'destructive' });
                            return;
                          }
                          setShowChunkingProgress(true);
                        }}
                        className={`gap-2 ${scrapedCount === 0 ? 'opacity-50' : ''}`}
                        disabled={scrapedCount === 0}
                      >
                        <Layers className="w-4 h-4" />
                        {t('generateChunks')}
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={() => {
                          const chunkCount = (activeProject as any)?.chunkCount || activeProject?.chunks?.length || 0;
                          if (chunkCount === 0) {
                            toast({ title: t('noChunksYet'), variant: 'destructive' });
                            return;
                          }
                          setShowRagPackProgress(true);
                        }}
                        className={`gap-2 ${((activeProject as any)?.chunkCount || activeProject?.chunks?.length || 0) === 0 ? 'opacity-50' : ''}`}
                        disabled={((activeProject as any)?.chunkCount || activeProject?.chunks?.length || 0) === 0}
                      >
                        <Package className="w-4 h-4" />
                        {t('exportRagPack')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setShowExportVersions(true)}
                        className="gap-2"
                        data-testid="button-export-versions"
                      >
                        <History className="w-4 h-4" />
                        RAG Pack Versionen
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem 
                        onClick={() => setWipeConfirmOpen(true)}
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
                      <Button variant="outline" size="sm" className="gap-2" disabled={isExportingProject} data-testid="export-button">
                        {isExportingProject ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                        {t('exportJson')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={exportProject} className="gap-2" data-testid="export-json">
                        <Download className="w-4 h-4" />
                        {t('exportJson')}
                      </DropdownMenuItem>
                      <DropdownMenuItem 
                        onClick={async () => {
                          if (!activeProject) return;
                          setIsExportingProject(true);
                          try {
                            const res = await apiRequest('GET', `/api/projects/${activeProject.id}/export`);
                            const fullProject = await res.json();
                            const results = fullProject.results || [];
                            const csvData = results.map((r: any) => ({
                              url: r.loc,
                              lastmod: r.lastmod || '',
                              title: r.scrapedData?.title || '',
                              wordCount: r.scrapedData?.wordCount || 0,
                              images: r.images?.length || 0,
                            }));
                            const headers = ['url', 'lastmod', 'title', 'wordCount', 'images'];
                            const csv = [
                              headers.join(','),
                              ...csvData.map((row: any) => headers.map(h => `"${String(row[h]).replace(/"/g, '""')}"`).join(','))
                            ].join('\n');
                            const dataStr = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
                            const a = document.createElement('a');
                            a.href = dataStr;
                            a.download = `${(activeProject.displayName || activeProject.domain).replace(/[^a-z0-9]/gi, '_')}-export.csv`;
                            a.click();
                          } catch (error) {
                            toast({ title: t('error'), variant: 'destructive' });
                          } finally {
                            setIsExportingProject(false);
                          }
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

              {isProcessing && isLockedByOtherTab(activeProject) && (
                <LockTakeoverBanner
                  isTakingLock={isTakingLock}
                  description={t('takeLockBannerDesc') || 'Wird in einem anderen Tab verarbeitet.'}
                  buttonLabel={t('takeLockButton') || 'Übernehmen'}
                  onTakeLock={() => activeProject && takeLock(activeProject.id)}
                />
              )}

              {hasActiveProcess && (
                <div className={`border rounded-xl p-4 ${isPaused ? 'bg-muted border-border' : 'bg-primary/10 border-primary/20'}`}>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 shrink-0">
                      {isPaused ? (
                        <>
                          <Button
                            size="icon"
                            onClick={resumeProcess}
                            disabled={processAction !== null}
                            data-testid="resume-button"
                          >
                            {processAction === 'resume' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Play className="w-4 h-4" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="destructive"
                            onClick={stopProcess}
                            disabled={processAction !== null}
                            data-testid="cancel-button"
                          >
                            {processAction === 'stop' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <X className="w-4 h-4" />
                            )}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin text-primary" />
                          <Button
                            size="icon"
                            variant="outline"
                            onClick={pauseProcess}
                            disabled={processAction !== null}
                            data-testid="pause-button"
                          >
                            {processAction === 'pause' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Pause className="w-4 h-4" />
                            )}
                          </Button>
                          <Button
                            size="icon"
                            variant="destructive"
                            onClick={stopProcess}
                            disabled={processAction !== null}
                            data-testid="stop-process-button"
                          >
                            {processAction === 'stop' ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </Button>
                        </>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {(activeProject?.status === 'crawling' || activeProject?.status === 'crawl_paused')
                              ? t('crawlingLabel')
                              : (activeProject?.status === 'scraping' || activeProject?.status === 'paused')
                                ? t('parallelAnalysis')
                                : t('deepExtraction')}
                          </p>
                          {isPaused && (
                            <Badge variant="secondary" className="text-[10px]">{t('paused')}</Badge>
                          )}
                          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full" data-testid="active-settings-badge">
                            ⚡ {activeProject?.projectSettings?.scraping?.parallelRequests ?? 10} {t('activeSettingsParallel')} · {activeProject?.projectSettings?.scraping?.delayMs ?? 500}ms {t('activeSettingsDelay')}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span>{t('urlsFound')}: {urlCount}</span>
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
                      {!isPaused && (
                        <LiveActivityFeed
                          feed={(activeProject?.id != null ? liveFeed[activeProject.id] : undefined) || []}
                          processedCount={(activeProject?.id != null ? sessionStats[activeProject.id]?.processedCount : 0) ?? 0}
                          pagesPerMinute={liveRateStats.pagesPerMinute}
                          etaMs={liveRateStats.etaMs}
                          t={t}
                        />
                      )}
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
                        {pendingContentScrape} {t('pending')} | {scrapedCount} {t('sequentialDataReady')}{failedCount > 0 ? ` | ${failedCount} Failed` : ''}
                        {hasUnsyncedErrors && ` | ${errorsArrayCount} errors in log`}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {hasUnsyncedErrors && (
                        <Button 
                          variant="outline" 
                          onClick={syncErrors} 
                          disabled={isSyncingErrors}
                          className="gap-2" 
                          data-testid="sync-errors-button"
                        >
                          {isSyncingErrors ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-amber-500" />
                          )}
                          Sync Errors
                        </Button>
                      )}
                      <Button onClick={startContentScrape} disabled={isStartingExtraction} className="gap-2" data-testid="start-extraction-button">
                        {isStartingExtraction ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                        {t('startExtraction')}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <StatsCards 
                urlCount={urlCount}
                scrapedCount={scrapedCount}
                failedCount={failedCount}
                pendingCount={pendingContentScrape}
                attachmentCount={attachmentCount}
                t={t} 
              />

              {scrapedCount > 0 && (
                <div className="bg-card border border-border rounded-xl p-4" data-testid="image-dedup-panel">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <Images className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{t('imageDedupTitle')}</p>
                        {sharedImagesData?.computed ? (
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1">
                            <span className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">{sharedImagesData.images.length}</span>{' '}
                              {t('imageDedupSharedImages')}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">
                                {sharedImagesData.images.reduce((s, img) => s + img.count, 0)}
                              </span>{' '}
                              {t('imageDedupOccurrences')}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">
                                {sharedImagesData.images.reduce((s, img) => s + Math.max(0, img.count - 1), 0)}
                              </span>{' '}
                              {t('imageDedupSaved')}
                            </span>
                            {sharedImagesData.lastComputedAt && (
                              <span className="text-xs text-muted-foreground">
                                {t('imageDedupLastRun')}:{' '}
                                {new Date(sharedImagesData.lastComputedAt).toLocaleString()}
                              </span>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground mt-0.5">{t('imageDedupNotRun')} · {t('imageDedupDesc')}</p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5"
                      disabled={isDeduping || isProcessing}
                      onClick={() => {
                        if (!activeProject) return;
                        setIsDeduping(true);
                        dedupeImagesMutation.mutate(activeProject.id);
                      }}
                      data-testid="run-image-dedup-button"
                    >
                      {isDeduping ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      {isDeduping ? t('imageDedupRunning') : t('imageDedupRun')}
                    </Button>
                  </div>
                </div>
              )}

              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <Tabs value={activeResultsTab} onValueChange={(v) => setActiveResultsTab(v as 'urls' | 'errors')} className="flex flex-col">
                  <TabsList className="w-full justify-start border-b border-border rounded-none bg-transparent p-0">
                    <TabsTrigger 
                      value="urls" 
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
                      data-testid="tab-urls"
                    >
                      {t('analyzedPages')} ({urlCount.toLocaleString()})
                    </TabsTrigger>
                    <TabsTrigger 
                      value="errors" 
                      className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-6 py-3"
                      data-testid="tab-errors"
                    >
                      {t('crawlFailures')} ({errorsArrayCount})
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="urls" className="m-0 min-h-[400px]">
                    <UrlList 
                      urls={activeResultsTab === 'urls' ? (resultsPageData?.results || []) : []}
                      totalCount={activeResultsTab === 'urls' ? (resultsPageData?.total ?? urlCount) : 0}
                      isLoading={activeResultsTab === 'urls' && (isResultsPageLoading || isResultsPageFetching)}
                      page={resultsPage}
                      pageSize={resultsPageSize}
                      onPageChange={setResultsPage}
                      onPageSizeChange={(size) => { setResultsPageSize(size); setResultsPage(0); }}
                      search={resultsSearch}
                      onSearchChange={setResultsSearch}
                      activeFolder={resultsFolder}
                      onFolderChange={setResultsFolder}
                      folderStats={resultsSummary?.folders || []}
                      projectId={activeProject?.id || 0} 
                      t={t} 
                      chunks={activeProject?.chunks || []} 
                      onRescrapeUrl={() => {
                        queryClient.invalidateQueries({ queryKey: ['/api/projects', activeProjectId, 'results'] });
                        queryClient.invalidateQueries({ queryKey: projectResultsSummaryQuery(activeProjectId).queryKey });
                      }}
                    />
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
          totalPages={scrapedCount}
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

      {showRagPackProgress && activeProject && (
        <RagPackProgress
          open={showRagPackProgress}
          onClose={() => setShowRagPackProgress(false)}
          projectId={activeProject.id}
          mode="project"
          onComplete={() => {
            queryClient.invalidateQueries({ queryKey: ['/api/projects', activeProject.id, 'exports'] });
          }}
          t={t}
        />
      )}

      {showExportVersions && activeProject && (
        <ExportVersionsDialog
          open={showExportVersions}
          onClose={() => setShowExportVersions(false)}
          projectId={activeProject.id}
        />
      )}

      {attachmentSync && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" data-testid="attachment-sync-dialog">
          <Card className="w-full max-w-md mx-4">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Paperclip className="w-5 h-5" />
                {t('syncAttachments')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!attachmentSync.done && attachmentSync.total > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {attachmentSync.processed} / {attachmentSync.total} HTML-Seiten
                    </span>
                    <span className="font-medium">
                      {Math.round((attachmentSync.processed / attachmentSync.total) * 100)}%
                    </span>
                  </div>
                  <Progress value={(attachmentSync.processed / attachmentSync.total) * 100} />
                </div>
              )}

              {!attachmentSync.done && attachmentSync.total === 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('syncAttachmentsStarted')}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="bg-muted/50 rounded-md p-2.5">
                  <div className="text-muted-foreground text-xs mb-0.5">PDFs auf HTML-Seiten</div>
                  <div className="font-semibold text-lg" data-testid="text-pdfs-found">{attachmentSync.pdfsFound}</div>
                </div>
                <div className="bg-muted/50 rounded-md p-2.5">
                  <div className="text-muted-foreground text-xs mb-0.5">Direkte PDF-URLs</div>
                  <div className="font-semibold text-lg" data-testid="text-direct-pdfs">{attachmentSync.directPdfs}</div>
                </div>
                {attachmentSync.errors > 0 && (
                  <div className="bg-destructive/10 rounded-md p-2.5 col-span-2">
                    <div className="text-destructive text-xs mb-0.5">Fehler</div>
                    <div className="font-semibold text-lg text-destructive">{attachmentSync.errors}</div>
                  </div>
                )}
              </div>

              {attachmentSync.done && (
                <Button
                  className="w-full"
                  onClick={() => setAttachmentSync(null)}
                  data-testid="button-close-sync-dialog"
                >
                  {t('close') || 'Schließen'}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={wipeConfirmOpen}
        onOpenChange={setWipeConfirmOpen}
        title={t('clearAllProgress')}
        description={t('wipeConfirm')}
        confirmText={t('delete')}
        cancelText={t('cancel')}
        variant="destructive"
        onConfirm={() => {
          if (!activeProject) return;
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
        }}
      />

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

      <ConfirmDialog
        open={deleteSinglePageConfirm.open}
        onOpenChange={(open) => setDeleteSinglePageConfirm(prev => ({ ...prev, open }))}
        title={t('deleteSinglePage')}
        description={t('deleteSinglePageMessage').replace('{name}', deleteSinglePageConfirm.pageName)}
        confirmText={t('delete')}
        cancelText={t('cancel')}
        variant="destructive"
        onConfirm={() => {
          if (deleteSinglePageConfirm.pageId) {
            deleteSinglePageMutation.mutate(deleteSinglePageConfirm.pageId);
          }
        }}
      />

      {renameSinglePage.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setRenameSinglePage({ open: false, pageId: null, currentTitle: '', newTitle: '' })}>
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-2">{t('renamePage') || 'Seite umbenennen'}</h3>
            <p className="text-sm text-muted-foreground mb-4">{t('renamePageDescription') || 'Geben Sie einen neuen Titel für die Seite ein.'}</p>
            <Input
              value={renameSinglePage.newTitle}
              onChange={(e) => setRenameSinglePage(prev => ({ ...prev, newTitle: e.target.value }))}
              placeholder={renameSinglePage.currentTitle}
              className="mb-4"
              data-testid="rename-page-input"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && renameSinglePage.pageId && renameSinglePage.newTitle.trim()) {
                  renameSinglePageMutation.mutate({ id: renameSinglePage.pageId, title: renameSinglePage.newTitle.trim() });
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRenameSinglePage({ open: false, pageId: null, currentTitle: '', newTitle: '' })} data-testid="cancel-rename-button">
                {t('cancel')}
              </Button>
              <Button 
                onClick={() => {
                  if (renameSinglePage.pageId && renameSinglePage.newTitle.trim()) {
                    renameSinglePageMutation.mutate({ id: renameSinglePage.pageId, title: renameSinglePage.newTitle.trim() });
                  }
                }}
                disabled={!renameSinglePage.newTitle.trim() || renameSinglePageMutation.isPending}
                data-testid="confirm-rename-button"
              >
                {renameSinglePageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : (t('save') || 'Speichern')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {convertDialog.open && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setConvertDialog({ open: false, projectName: '', deleteSinglePages: false })}>
          <div className="bg-card border border-border rounded-lg p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <FolderPlus className="w-5 h-5" />
              {t('convertToProject')}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t('convertToProjectDescription').replace('{count}', String(selectedSinglePages.size))}
            </p>
            <Input
              value={convertDialog.projectName}
              onChange={(e) => setConvertDialog(prev => ({ ...prev, projectName: e.target.value }))}
              placeholder={t('projectName')}
              className="mb-3"
              data-testid="convert-project-name-input"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && convertDialog.projectName.trim()) {
                  convertToProjectMutation.mutate({
                    name: convertDialog.projectName.trim(),
                    singlePageIds: Array.from(selectedSinglePages),
                    deleteSinglePages: convertDialog.deleteSinglePages,
                  });
                }
              }}
            />
            <label className="flex items-center gap-2 mb-4 cursor-pointer select-none" data-testid="checkbox-delete-single-pages">
              <input
                type="checkbox"
                checked={convertDialog.deleteSinglePages}
                onChange={(e) => setConvertDialog(prev => ({ ...prev, deleteSinglePages: e.target.checked }))}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span className="text-sm text-muted-foreground">{t('deleteSinglePagesAfterConvert')}</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConvertDialog({ open: false, projectName: '', deleteSinglePages: false })} data-testid="cancel-convert-button">
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  if (convertDialog.projectName.trim()) {
                    convertToProjectMutation.mutate({
                      name: convertDialog.projectName.trim(),
                      singlePageIds: Array.from(selectedSinglePages),
                      deleteSinglePages: convertDialog.deleteSinglePages,
                    });
                  }
                }}
                disabled={!convertDialog.projectName.trim() || convertToProjectMutation.isPending}
                className="gap-2"
                data-testid="confirm-convert-button"
              >
                {convertToProjectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderPlus className="w-4 h-4" />}
                {t('createProject')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Rate-limit rollback modal */}
      {rateLimitModal && (
        <Dialog open={rateLimitModal.open} onOpenChange={(open) => !open && setRateLimitModal(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-400">
                <AlertTriangle className="w-5 h-5" />
                {t('rateLimitRollbackTitle')}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <p className="text-sm text-muted-foreground">
                {t('rateLimitRollbackDesc')
                  .replace('{from}', String(rateLimitModal.fromValue))
                  .replace('{to}', String(rateLimitModal.toValue))}
              </p>
              <p className="text-sm text-muted-foreground">{t('rateLimitRollbackHint')}</p>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={rateLimitModal.customValue}
                  onChange={(e) => setRateLimitModal(prev => prev ? { ...prev, customValue: Math.max(1, Math.min(50, parseInt(e.target.value) || 1)) } : null)}
                  className="w-24"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    if (!rateLimitModal) return;
                    const newSettings = {
                      ...(projects.find(p => p.id === rateLimitModal.projectId)?.projectSettings ?? {}),
                      scraping: {
                        ...(projects.find(p => p.id === rateLimitModal.projectId)?.projectSettings?.scraping ?? {}),
                        parallelRequests: rateLimitModal.customValue,
                      },
                    };
                    await updateProjectMutation.mutateAsync({
                      id: rateLimitModal.projectId,
                      updates: { projectSettings: newSettings as any },
                    });
                    setRateLimitModal(null);
                  }}
                >
                  {t('rateLimitApply')}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRateLimitModal(null)}>
                {t('close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function isConflictError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('409');
}

function isLockedByOtherTab(project: { scrapeLock?: { owner: string; expiresAt: number } | null } | undefined): boolean {
  return isLockedByOtherTabUtil(project, TAB_ID);
}
