import { useState, useEffect } from 'react';
import { X, Settings, Sliders, Brain, Cpu, Info, Plus, Trash2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import type { ProjectSettings as ProjectSettingsType, ProxyConfig } from '@shared/schema';

interface ProjectSettingsProps {
  settings: ProjectSettingsType | null | undefined;
  onSave: (settings: ProjectSettingsType) => void;
  onClose: () => void;
  t: (key: any) => string;
}

const defaultSettings: ProjectSettingsType = {
  scraping: {
    parallelRequests: 10,
    delayMs: 500,
    contentSelectors: ['article', 'main', '.content', '#content'],
    excludeSelectors: ['nav', 'footer', 'header', '.sidebar', '.ads'],
    maxDepth: 5,
    rateLimiting: {
      enabled: true,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
    },
    proxies: [],
    rotateProxies: false,
    extractStructuredData: true,
  },
  chunking: {
    targetTokens: 350,
    overlapTokens: 55,
    boundaryRules: ['paragraph', 'heading'],
    preserveHeadingHierarchy: true,
    minChunkTokens: 50,
    preserveTables: true,
    preserveCodeBlocks: true,
    multiLanguageTokenization: true,
    qualityChecks: {
      enabled: true,
      minWordCount: 10,
      warnOnShortChunks: true,
      warnOnNoContent: true,
    },
    deduplication: {
      enabled: true,
      similarityThreshold: 0.95,
    },
  },
  ai: {
    enabled: false,
    endpoint: '',
    bearerToken: '',
    model: 'gpt-4o-mini',
    features: {
      semanticChunking: false,
      summaries: false,
      keywordExtraction: false,
    },
    embeddings: {
      enabled: false,
      model: 'text-embedding-3-small',
      dimensions: 1536,
    },
    metadataEnrichment: {
      enabled: false,
      extractKeywords: true,
      generateSummary: true,
      detectCategory: false,
      extractEntities: false,
    },
  },
  export: {
    formats: ['json'],
    includeEmbeddings: false,
    incrementalUpdates: true,
  },
};

export default function ProjectSettings({ settings, onSave, onClose, t }: ProjectSettingsProps) {
  const [localSettings, setLocalSettings] = useState<ProjectSettingsType>(
    settings || defaultSettings
  );
  const [newProxyUrl, setNewProxyUrl] = useState('');
  const [newProxyProtocol, setNewProxyProtocol] = useState<'http' | 'https' | 'socks5'>('http');

  useEffect(() => {
    if (settings) {
      setLocalSettings({
        scraping: { 
          ...defaultSettings.scraping, 
          ...settings.scraping,
          rateLimiting: { ...defaultSettings.scraping.rateLimiting, ...settings.scraping?.rateLimiting },
          proxies: settings.scraping?.proxies || [],
        },
        chunking: { 
          ...defaultSettings.chunking, 
          ...settings.chunking,
          qualityChecks: { ...defaultSettings.chunking.qualityChecks, ...settings.chunking?.qualityChecks },
          deduplication: { ...defaultSettings.chunking.deduplication, ...settings.chunking?.deduplication },
        },
        ai: { 
          ...defaultSettings.ai, 
          ...settings.ai,
          features: { ...defaultSettings.ai.features, ...settings.ai?.features },
          embeddings: { ...defaultSettings.ai.embeddings, ...settings.ai?.embeddings },
          metadataEnrichment: { ...defaultSettings.ai.metadataEnrichment, ...settings.ai?.metadataEnrichment },
        },
        export: { ...defaultSettings.export, ...settings.export },
      });
    }
  }, [settings]);

  const handleSave = () => {
    onSave(localSettings);
    onClose();
  };

  const updateScraping = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      scraping: { ...prev.scraping, [key]: value },
    }));
  };

  const updateRateLimiting = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      scraping: { 
        ...prev.scraping, 
        rateLimiting: { ...prev.scraping.rateLimiting, [key]: value },
      },
    }));
  };

  const addProxy = () => {
    if (!newProxyUrl.trim()) return;
    const newProxy: ProxyConfig = {
      url: newProxyUrl.trim(),
      protocol: newProxyProtocol,
    };
    setLocalSettings(prev => ({
      ...prev,
      scraping: { 
        ...prev.scraping, 
        proxies: [...(prev.scraping.proxies || []), newProxy],
      },
    }));
    setNewProxyUrl('');
  };

  const removeProxy = (index: number) => {
    setLocalSettings(prev => ({
      ...prev,
      scraping: { 
        ...prev.scraping, 
        proxies: (prev.scraping.proxies || []).filter((_, i) => i !== index),
      },
    }));
  };

  const updateChunking = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      chunking: { ...prev.chunking, [key]: value },
    }));
  };

  const updateQualityChecks = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      chunking: { 
        ...prev.chunking, 
        qualityChecks: { ...prev.chunking.qualityChecks, [key]: value },
      },
    }));
  };

  const updateDeduplication = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      chunking: { 
        ...prev.chunking, 
        deduplication: { ...prev.chunking.deduplication, [key]: value },
      },
    }));
  };

  const updateAi = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      ai: { ...prev.ai, [key]: value },
    }));
  };

  const updateAiFeatures = (key: string, value: boolean) => {
    setLocalSettings(prev => ({
      ...prev,
      ai: { 
        ...prev.ai, 
        features: { ...prev.ai.features, [key]: value },
      },
    }));
  };

  const updateEmbeddings = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      ai: { 
        ...prev.ai, 
        embeddings: { ...prev.ai.embeddings, [key]: value },
      },
    }));
  };

  const updateMetadataEnrichment = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      ai: { 
        ...prev.ai, 
        metadataEnrichment: { ...prev.ai.metadataEnrichment, [key]: value },
      },
    }));
  };

  const updateExport = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      export: { ...prev.export, [key]: value },
    }));
  };

  const toggleExportFormat = (format: 'json' | 'csv' | 'parquet' | 'markdown') => {
    const current = localSettings.export?.formats || [];
    const newFormats = current.includes(format)
      ? current.filter(f => f !== format)
      : [...current, format];
    updateExport('formats', newFormats);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" data-testid="settings-modal">
      <div className="bg-card border border-border rounded-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center">
              <Settings className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">{t('projectSettings')}</h2>
              <p className="text-xs text-muted-foreground">Deep Scraping & RAG Chunking Konfiguration</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="close-settings">
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <Tabs defaultValue="scraping" className="w-full">
            <TabsList className="grid w-full grid-cols-4 mb-4">
              <TabsTrigger value="scraping" className="gap-2" data-testid="tab-scraping">
                <Sliders className="w-4 h-4" />
                {t('scrapingSettings')}
              </TabsTrigger>
              <TabsTrigger value="chunking" className="gap-2" data-testid="tab-chunking">
                <Cpu className="w-4 h-4" />
                {t('chunkingSettings')}
              </TabsTrigger>
              <TabsTrigger value="ai" className="gap-2" data-testid="tab-ai">
                <Brain className="w-4 h-4" />
                {t('aiSettings')}
              </TabsTrigger>
              <TabsTrigger value="export" className="gap-2" data-testid="tab-export">
                <Download className="w-4 h-4" />
                {t('exportSettings')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="scraping" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('scrapingSettings')}</CardTitle>
                  <CardDescription>{t('scrapingSettingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="parallelRequests">{t('parallelRequests')}</Label>
                      <span className="text-sm font-medium text-primary">{localSettings.scraping.parallelRequests}</span>
                    </div>
                    <Slider
                      id="parallelRequests"
                      min={1}
                      max={20}
                      step={1}
                      value={[localSettings.scraping.parallelRequests]}
                      onValueChange={([v]) => updateScraping('parallelRequests', v)}
                      data-testid="slider-parallel"
                    />
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      {t('parallelRequestsInfo')}
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="delayMs">{t('requestDelay')}</Label>
                      <span className="text-sm font-medium text-primary">{localSettings.scraping.delayMs}ms</span>
                    </div>
                    <Slider
                      id="delayMs"
                      min={0}
                      max={5000}
                      step={100}
                      value={[localSettings.scraping.delayMs]}
                      onValueChange={([v]) => updateScraping('delayMs', v)}
                      data-testid="slider-delay"
                    />
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      {t('requestDelayInfo')}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="contentSelectors">{t('contentSelectors')}</Label>
                    <Input
                      id="contentSelectors"
                      value={localSettings.scraping.contentSelectors.join(', ')}
                      onChange={(e) => updateScraping('contentSelectors', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                      placeholder="article, main, .content, #content"
                      data-testid="input-content-selectors"
                    />
                    <p className="text-xs text-muted-foreground">{t('contentSelectorsInfo')}</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="excludeSelectors">{t('excludeSelectors')}</Label>
                    <Input
                      id="excludeSelectors"
                      value={localSettings.scraping.excludeSelectors.join(', ')}
                      onChange={(e) => updateScraping('excludeSelectors', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                      placeholder="nav, footer, header, .sidebar"
                      data-testid="input-exclude-selectors"
                    />
                    <p className="text-xs text-muted-foreground">{t('excludeSelectorsInfo')}</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('rateLimiting')}</CardTitle>
                  <CardDescription>{t('rateLimitingDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="rateLimitingEnabled">{t('enableRateLimiting')}</Label>
                      <p className="text-xs text-muted-foreground">{t('enableRateLimitingInfo')}</p>
                    </div>
                    <Switch
                      id="rateLimitingEnabled"
                      checked={localSettings.scraping.rateLimiting?.enabled ?? true}
                      onCheckedChange={(v) => updateRateLimiting('enabled', v)}
                      data-testid="switch-rate-limiting"
                    />
                  </div>

                  {localSettings.scraping.rateLimiting?.enabled && (
                    <>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="baseDelayMs">{t('baseDelay')}</Label>
                          <span className="text-sm font-medium text-primary">{localSettings.scraping.rateLimiting?.baseDelayMs || 500}ms</span>
                        </div>
                        <Slider
                          id="baseDelayMs"
                          min={100}
                          max={10000}
                          step={100}
                          value={[localSettings.scraping.rateLimiting?.baseDelayMs || 500]}
                          onValueChange={([v]) => updateRateLimiting('baseDelayMs', v)}
                          data-testid="slider-base-delay"
                        />
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="maxDelayMs">{t('maxDelay')}</Label>
                          <span className="text-sm font-medium text-primary">{localSettings.scraping.rateLimiting?.maxDelayMs || 30000}ms</span>
                        </div>
                        <Slider
                          id="maxDelayMs"
                          min={1000}
                          max={60000}
                          step={1000}
                          value={[localSettings.scraping.rateLimiting?.maxDelayMs || 30000]}
                          onValueChange={([v]) => updateRateLimiting('maxDelayMs', v)}
                          data-testid="slider-max-delay"
                        />
                      </div>

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="backoffMultiplier">{t('backoffMultiplier')}</Label>
                          <span className="text-sm font-medium text-primary">{localSettings.scraping.rateLimiting?.backoffMultiplier || 2}x</span>
                        </div>
                        <Slider
                          id="backoffMultiplier"
                          min={1.5}
                          max={5}
                          step={0.5}
                          value={[localSettings.scraping.rateLimiting?.backoffMultiplier || 2]}
                          onValueChange={([v]) => updateRateLimiting('backoffMultiplier', v)}
                          data-testid="slider-backoff"
                        />
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('proxySettings')}</CardTitle>
                  <CardDescription>{t('proxySettingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="rotateProxies">{t('rotateProxies')}</Label>
                      <p className="text-xs text-muted-foreground">{t('rotateProxiesInfo')}</p>
                    </div>
                    <Switch
                      id="rotateProxies"
                      checked={localSettings.scraping.rotateProxies ?? false}
                      onCheckedChange={(v) => updateScraping('rotateProxies', v)}
                      data-testid="switch-rotate-proxies"
                    />
                  </div>

                  <div className="space-y-3">
                    <Label>{t('proxyList')}</Label>
                    <div className="flex gap-2">
                      <Select value={newProxyProtocol} onValueChange={(v) => setNewProxyProtocol(v as any)}>
                        <SelectTrigger className="w-28" data-testid="select-proxy-protocol">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="http">HTTP</SelectItem>
                          <SelectItem value="https">HTTPS</SelectItem>
                          <SelectItem value="socks5">SOCKS5</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        value={newProxyUrl}
                        onChange={(e) => setNewProxyUrl(e.target.value)}
                        placeholder="proxy.example.com:8080"
                        className="flex-1"
                        data-testid="input-proxy-url"
                      />
                      <Button size="icon" onClick={addProxy} data-testid="add-proxy-button">
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                    
                    {(localSettings.scraping.proxies || []).length > 0 && (
                      <div className="space-y-2 mt-3">
                        {(localSettings.scraping.proxies || []).map((proxy, index) => (
                          <div key={index} className="flex items-center gap-2 p-2 bg-muted/50 rounded-md">
                            <Badge variant="secondary" className="text-xs">{proxy.protocol.toUpperCase()}</Badge>
                            <span className="flex-1 text-sm font-mono truncate">{proxy.url}</span>
                            <Button 
                              size="icon" 
                              variant="ghost" 
                              onClick={() => removeProxy(index)}
                              data-testid={`remove-proxy-${index}`}
                            >
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('structuredDataSettings')}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="extractStructuredData">{t('extractStructuredData')}</Label>
                      <p className="text-xs text-muted-foreground">{t('extractStructuredDataInfo')}</p>
                    </div>
                    <Switch
                      id="extractStructuredData"
                      checked={localSettings.scraping.extractStructuredData ?? true}
                      onCheckedChange={(v) => updateScraping('extractStructuredData', v)}
                      data-testid="switch-structured-data"
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="chunking" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('chunkingSettings')}</CardTitle>
                  <CardDescription>{t('chunkingSettingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="targetTokens">{t('targetTokens')}</Label>
                      <span className="text-sm font-medium text-primary">{localSettings.chunking.targetTokens}</span>
                    </div>
                    <Slider
                      id="targetTokens"
                      min={100}
                      max={2000}
                      step={50}
                      value={[localSettings.chunking.targetTokens]}
                      onValueChange={([v]) => updateChunking('targetTokens', v)}
                      data-testid="slider-target-tokens"
                    />
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      {t('targetTokensInfo')}
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="overlapTokens">{t('overlapTokens')}</Label>
                      <span className="text-sm font-medium text-primary">{localSettings.chunking.overlapTokens}</span>
                    </div>
                    <Slider
                      id="overlapTokens"
                      min={0}
                      max={200}
                      step={5}
                      value={[localSettings.chunking.overlapTokens]}
                      onValueChange={([v]) => updateChunking('overlapTokens', v)}
                      data-testid="slider-overlap"
                    />
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      {t('overlapTokensInfo')}
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="minChunkTokens">{t('minChunkTokens')}</Label>
                      <span className="text-sm font-medium text-primary">{localSettings.chunking.minChunkTokens}</span>
                    </div>
                    <Slider
                      id="minChunkTokens"
                      min={20}
                      max={200}
                      step={10}
                      value={[localSettings.chunking.minChunkTokens]}
                      onValueChange={([v]) => updateChunking('minChunkTokens', v)}
                      data-testid="slider-min-tokens"
                    />
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      {t('minChunkTokensInfo')}
                    </p>
                  </div>

                  <div className="space-y-3">
                    <Label>{t('boundaryRules')}</Label>
                    <div className="flex flex-wrap gap-2">
                      {(['paragraph', 'heading', 'sentence'] as const).map(rule => (
                        <Badge
                          key={rule}
                          variant={localSettings.chunking.boundaryRules.includes(rule) ? 'default' : 'secondary'}
                          className="cursor-pointer"
                          onClick={() => {
                            const current = localSettings.chunking.boundaryRules;
                            const newRules = current.includes(rule)
                              ? current.filter(r => r !== rule)
                              : [...current, rule];
                            updateChunking('boundaryRules', newRules);
                          }}
                          data-testid={`badge-${rule}`}
                        >
                          {t(rule)}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">{t('boundaryRulesInfo')}</p>
                  </div>

                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="preserveHeadings">{t('preserveHeadings')}</Label>
                      <p className="text-xs text-muted-foreground">{t('preserveHeadingsInfo')}</p>
                    </div>
                    <Switch
                      id="preserveHeadings"
                      checked={localSettings.chunking.preserveHeadingHierarchy}
                      onCheckedChange={(v) => updateChunking('preserveHeadingHierarchy', v)}
                      data-testid="switch-preserve-headings"
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('contentPreservation')}</CardTitle>
                  <CardDescription>{t('contentPreservationDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="preserveTables">{t('preserveTables')}</Label>
                      <p className="text-xs text-muted-foreground">{t('preserveTablesInfo')}</p>
                    </div>
                    <Switch
                      id="preserveTables"
                      checked={localSettings.chunking.preserveTables ?? true}
                      onCheckedChange={(v) => updateChunking('preserveTables', v)}
                      data-testid="switch-preserve-tables"
                    />
                  </div>

                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="preserveCodeBlocks">{t('preserveCodeBlocks')}</Label>
                      <p className="text-xs text-muted-foreground">{t('preserveCodeBlocksInfo')}</p>
                    </div>
                    <Switch
                      id="preserveCodeBlocks"
                      checked={localSettings.chunking.preserveCodeBlocks ?? true}
                      onCheckedChange={(v) => updateChunking('preserveCodeBlocks', v)}
                      data-testid="switch-preserve-code"
                    />
                  </div>

                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="multiLanguageTokenization">{t('multiLanguageTokenization')}</Label>
                      <p className="text-xs text-muted-foreground">{t('multiLanguageTokenizationInfo')}</p>
                    </div>
                    <Switch
                      id="multiLanguageTokenization"
                      checked={localSettings.chunking.multiLanguageTokenization ?? true}
                      onCheckedChange={(v) => updateChunking('multiLanguageTokenization', v)}
                      data-testid="switch-multi-language"
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('qualityChecks')}</CardTitle>
                  <CardDescription>{t('qualityChecksDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="qualityChecksEnabled">{t('enableQualityChecks')}</Label>
                      <p className="text-xs text-muted-foreground">{t('enableQualityChecksInfo')}</p>
                    </div>
                    <Switch
                      id="qualityChecksEnabled"
                      checked={localSettings.chunking.qualityChecks?.enabled ?? true}
                      onCheckedChange={(v) => updateQualityChecks('enabled', v)}
                      data-testid="switch-quality-checks"
                    />
                  </div>

                  {localSettings.chunking.qualityChecks?.enabled && (
                    <>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="minWordCount">{t('minWordCount')}</Label>
                          <span className="text-sm font-medium text-primary">{localSettings.chunking.qualityChecks?.minWordCount || 10}</span>
                        </div>
                        <Slider
                          id="minWordCount"
                          min={5}
                          max={100}
                          step={5}
                          value={[localSettings.chunking.qualityChecks?.minWordCount || 10]}
                          onValueChange={([v]) => updateQualityChecks('minWordCount', v)}
                          data-testid="slider-min-word-count"
                        />
                      </div>

                      <div className="flex items-center justify-between py-2">
                        <div className="space-y-0.5">
                          <Label htmlFor="warnOnShortChunks">{t('warnOnShortChunks')}</Label>
                          <p className="text-xs text-muted-foreground">{t('warnOnShortChunksInfo')}</p>
                        </div>
                        <Switch
                          id="warnOnShortChunks"
                          checked={localSettings.chunking.qualityChecks?.warnOnShortChunks ?? true}
                          onCheckedChange={(v) => updateQualityChecks('warnOnShortChunks', v)}
                          data-testid="switch-warn-short"
                        />
                      </div>

                      <div className="flex items-center justify-between py-2">
                        <div className="space-y-0.5">
                          <Label htmlFor="warnOnNoContent">{t('warnOnNoContent')}</Label>
                          <p className="text-xs text-muted-foreground">{t('warnOnNoContentInfo')}</p>
                        </div>
                        <Switch
                          id="warnOnNoContent"
                          checked={localSettings.chunking.qualityChecks?.warnOnNoContent ?? true}
                          onCheckedChange={(v) => updateQualityChecks('warnOnNoContent', v)}
                          data-testid="switch-warn-no-content"
                        />
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('deduplicationSettings')}</CardTitle>
                  <CardDescription>{t('deduplicationSettingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="deduplicationEnabled">{t('enableDeduplication')}</Label>
                      <p className="text-xs text-muted-foreground">{t('enableDeduplicationInfo')}</p>
                    </div>
                    <Switch
                      id="deduplicationEnabled"
                      checked={localSettings.chunking.deduplication?.enabled ?? true}
                      onCheckedChange={(v) => updateDeduplication('enabled', v)}
                      data-testid="switch-deduplication"
                    />
                  </div>

                  {localSettings.chunking.deduplication?.enabled && (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="similarityThreshold">{t('similarityThreshold')}</Label>
                        <span className="text-sm font-medium text-primary">{((localSettings.chunking.deduplication?.similarityThreshold || 0.95) * 100).toFixed(0)}%</span>
                      </div>
                      <Slider
                        id="similarityThreshold"
                        min={0.7}
                        max={1}
                        step={0.01}
                        value={[localSettings.chunking.deduplication?.similarityThreshold || 0.95]}
                        onValueChange={([v]) => updateDeduplication('similarityThreshold', v)}
                        data-testid="slider-similarity"
                      />
                      <p className="text-xs text-muted-foreground">{t('similarityThresholdInfo')}</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="ai" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('aiSettings')}</CardTitle>
                  <CardDescription>{t('aiSettingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <div className="space-y-0.5">
                      <Label htmlFor="enableAi" className="text-base">{t('enableAi')}</Label>
                      <p className="text-xs text-muted-foreground">{t('enableAiInfo')}</p>
                    </div>
                    <Switch
                      id="enableAi"
                      checked={localSettings.ai.enabled}
                      onCheckedChange={(v) => updateAi('enabled', v)}
                      data-testid="switch-enable-ai"
                    />
                  </div>

                  {localSettings.ai.enabled && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="aiEndpoint">{t('aiEndpoint')}</Label>
                        <Input
                          id="aiEndpoint"
                          type="url"
                          value={localSettings.ai.endpoint || ''}
                          onChange={(e) => updateAi('endpoint', e.target.value)}
                          placeholder="https://api.openai.com/v1"
                          data-testid="input-ai-endpoint"
                        />
                        <p className="text-xs text-muted-foreground">{t('aiEndpointInfo')}</p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="bearerToken">{t('bearerToken')}</Label>
                        <Input
                          id="bearerToken"
                          type="password"
                          value={localSettings.ai.bearerToken || ''}
                          onChange={(e) => updateAi('bearerToken', e.target.value)}
                          placeholder="sk-..."
                          data-testid="input-bearer-token"
                        />
                        <p className="text-xs text-muted-foreground">{t('bearerTokenInfo')}</p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="aiModel">{t('aiModel')}</Label>
                        <Select
                          value={localSettings.ai.model}
                          onValueChange={(v) => updateAi('model', v)}
                        >
                          <SelectTrigger data-testid="select-ai-model">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="gpt-4o-mini">GPT-4o Mini</SelectItem>
                            <SelectItem value="gpt-4o">GPT-4o</SelectItem>
                            <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                            <SelectItem value="claude-3-haiku">Claude 3 Haiku</SelectItem>
                            <SelectItem value="claude-3-sonnet">Claude 3 Sonnet</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-4 pt-4 border-t border-border">
                        <Label className="text-sm font-medium">{t('aiFeatures')}</Label>
                        
                        <div className="flex items-center justify-between py-2">
                          <div className="space-y-0.5">
                            <Label htmlFor="semanticChunking" className="text-sm">{t('semanticChunking')}</Label>
                            <p className="text-xs text-muted-foreground">{t('semanticChunkingInfo')}</p>
                          </div>
                          <Switch
                            id="semanticChunking"
                            checked={localSettings.ai.features.semanticChunking}
                            onCheckedChange={(v) => updateAiFeatures('semanticChunking', v)}
                            data-testid="switch-semantic"
                          />
                        </div>

                        <div className="flex items-center justify-between py-2">
                          <div className="space-y-0.5">
                            <Label htmlFor="summaries" className="text-sm">{t('summaries')}</Label>
                            <p className="text-xs text-muted-foreground">{t('summariesInfo')}</p>
                          </div>
                          <Switch
                            id="summaries"
                            checked={localSettings.ai.features.summaries}
                            onCheckedChange={(v) => updateAiFeatures('summaries', v)}
                            data-testid="switch-summaries"
                          />
                        </div>

                        <div className="flex items-center justify-between py-2">
                          <div className="space-y-0.5">
                            <Label htmlFor="keywordExtraction" className="text-sm">{t('keywordExtraction')}</Label>
                            <p className="text-xs text-muted-foreground">{t('keywordExtractionInfo')}</p>
                          </div>
                          <Switch
                            id="keywordExtraction"
                            checked={localSettings.ai.features.keywordExtraction}
                            onCheckedChange={(v) => updateAiFeatures('keywordExtraction', v)}
                            data-testid="switch-keywords"
                          />
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {localSettings.ai.enabled && (
                <>
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{t('embeddingsSettings')}</CardTitle>
                      <CardDescription>{t('embeddingsSettingsDesc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex items-center justify-between py-2">
                        <div className="space-y-0.5">
                          <Label htmlFor="embeddingsEnabled">{t('enableEmbeddings')}</Label>
                          <p className="text-xs text-muted-foreground">{t('enableEmbeddingsInfo')}</p>
                        </div>
                        <Switch
                          id="embeddingsEnabled"
                          checked={localSettings.ai.embeddings?.enabled ?? false}
                          onCheckedChange={(v) => updateEmbeddings('enabled', v)}
                          data-testid="switch-embeddings"
                        />
                      </div>

                      {localSettings.ai.embeddings?.enabled && (
                        <>
                          <div className="space-y-2">
                            <Label htmlFor="embeddingsModel">{t('embeddingsModel')}</Label>
                            <Select
                              value={localSettings.ai.embeddings?.model || 'text-embedding-3-small'}
                              onValueChange={(v) => updateEmbeddings('model', v)}
                            >
                              <SelectTrigger data-testid="select-embeddings-model">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="text-embedding-3-small">text-embedding-3-small</SelectItem>
                                <SelectItem value="text-embedding-3-large">text-embedding-3-large</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <Label htmlFor="embeddingsDimensions">{t('embeddingsDimensions')}</Label>
                              <span className="text-sm font-medium text-primary">{localSettings.ai.embeddings?.dimensions || 1536}</span>
                            </div>
                            <Slider
                              id="embeddingsDimensions"
                              min={256}
                              max={3072}
                              step={256}
                              value={[localSettings.ai.embeddings?.dimensions || 1536]}
                              onValueChange={([v]) => updateEmbeddings('dimensions', v)}
                              data-testid="slider-dimensions"
                            />
                            <p className="text-xs text-muted-foreground">{t('embeddingsDimensionsInfo')}</p>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">{t('metadataEnrichment')}</CardTitle>
                      <CardDescription>{t('metadataEnrichmentDesc')}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex items-center justify-between py-2">
                        <div className="space-y-0.5">
                          <Label htmlFor="metadataEnabled">{t('enableMetadataEnrichment')}</Label>
                          <p className="text-xs text-muted-foreground">{t('enableMetadataEnrichmentInfo')}</p>
                        </div>
                        <Switch
                          id="metadataEnabled"
                          checked={localSettings.ai.metadataEnrichment?.enabled ?? false}
                          onCheckedChange={(v) => updateMetadataEnrichment('enabled', v)}
                          data-testid="switch-metadata"
                        />
                      </div>

                      {localSettings.ai.metadataEnrichment?.enabled && (
                        <>
                          <div className="flex items-center justify-between py-2">
                            <div className="space-y-0.5">
                              <Label htmlFor="extractKeywords" className="text-sm">{t('extractKeywordsMetadata')}</Label>
                              <p className="text-xs text-muted-foreground">{t('extractKeywordsMetadataInfo')}</p>
                            </div>
                            <Switch
                              id="extractKeywords"
                              checked={localSettings.ai.metadataEnrichment?.extractKeywords ?? true}
                              onCheckedChange={(v) => updateMetadataEnrichment('extractKeywords', v)}
                              data-testid="switch-extract-keywords"
                            />
                          </div>

                          <div className="flex items-center justify-between py-2">
                            <div className="space-y-0.5">
                              <Label htmlFor="generateSummary" className="text-sm">{t('generateSummaryMetadata')}</Label>
                              <p className="text-xs text-muted-foreground">{t('generateSummaryMetadataInfo')}</p>
                            </div>
                            <Switch
                              id="generateSummary"
                              checked={localSettings.ai.metadataEnrichment?.generateSummary ?? true}
                              onCheckedChange={(v) => updateMetadataEnrichment('generateSummary', v)}
                              data-testid="switch-generate-summary"
                            />
                          </div>

                          <div className="flex items-center justify-between py-2">
                            <div className="space-y-0.5">
                              <Label htmlFor="detectCategory" className="text-sm">{t('detectCategory')}</Label>
                              <p className="text-xs text-muted-foreground">{t('detectCategoryInfo')}</p>
                            </div>
                            <Switch
                              id="detectCategory"
                              checked={localSettings.ai.metadataEnrichment?.detectCategory ?? false}
                              onCheckedChange={(v) => updateMetadataEnrichment('detectCategory', v)}
                              data-testid="switch-detect-category"
                            />
                          </div>

                          <div className="flex items-center justify-between py-2">
                            <div className="space-y-0.5">
                              <Label htmlFor="extractEntities" className="text-sm">{t('extractEntities')}</Label>
                              <p className="text-xs text-muted-foreground">{t('extractEntitiesInfo')}</p>
                            </div>
                            <Switch
                              id="extractEntities"
                              checked={localSettings.ai.metadataEnrichment?.extractEntities ?? false}
                              onCheckedChange={(v) => updateMetadataEnrichment('extractEntities', v)}
                              data-testid="switch-extract-entities"
                            />
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>

            <TabsContent value="export" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('exportSettings')}</CardTitle>
                  <CardDescription>{t('exportSettingsDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <Label>{t('exportFormats')}</Label>
                    <div className="grid grid-cols-2 gap-3">
                      {(['json', 'csv', 'parquet', 'markdown'] as const).map(format => (
                        <div key={format} className="flex items-center space-x-2">
                          <Checkbox
                            id={`format-${format}`}
                            checked={(localSettings.export?.formats || []).includes(format)}
                            onCheckedChange={() => toggleExportFormat(format)}
                            data-testid={`checkbox-${format}`}
                          />
                          <Label htmlFor={`format-${format}`} className="text-sm font-normal cursor-pointer">
                            {format.toUpperCase()}
                          </Label>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">{t('exportFormatsInfo')}</p>
                  </div>

                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="includeEmbeddings">{t('includeEmbeddings')}</Label>
                      <p className="text-xs text-muted-foreground">{t('includeEmbeddingsInfo')}</p>
                    </div>
                    <Switch
                      id="includeEmbeddings"
                      checked={localSettings.export?.includeEmbeddings ?? false}
                      onCheckedChange={(v) => updateExport('includeEmbeddings', v)}
                      data-testid="switch-include-embeddings"
                    />
                  </div>

                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="incrementalUpdates">{t('incrementalUpdates')}</Label>
                      <p className="text-xs text-muted-foreground">{t('incrementalUpdatesInfo')}</p>
                    </div>
                    <Switch
                      id="incrementalUpdates"
                      checked={localSettings.export?.incrementalUpdates ?? true}
                      onCheckedChange={(v) => updateExport('incrementalUpdates', v)}
                      data-testid="switch-incremental"
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex items-center justify-end gap-3 p-4 border-t border-border shrink-0 bg-card">
          <Button variant="outline" onClick={onClose} data-testid="cancel-settings">
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} data-testid="save-settings">
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
