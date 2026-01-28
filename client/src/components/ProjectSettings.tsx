import { useState, useEffect } from 'react';
import { X, Settings, Sliders, Brain, Cpu, Info } from 'lucide-react';
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
import type { ProjectSettings as ProjectSettingsType } from '@shared/schema';

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
  },
  chunking: {
    targetTokens: 350,
    overlapTokens: 55,
    boundaryRules: ['paragraph', 'heading'],
    preserveHeadingHierarchy: true,
    minChunkTokens: 50,
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
  },
};

export default function ProjectSettings({ settings, onSave, onClose, t }: ProjectSettingsProps) {
  const [localSettings, setLocalSettings] = useState<ProjectSettingsType>(
    settings || defaultSettings
  );

  useEffect(() => {
    if (settings) {
      setLocalSettings({
        scraping: { ...defaultSettings.scraping, ...settings.scraping },
        chunking: { ...defaultSettings.chunking, ...settings.chunking },
        ai: { 
          ...defaultSettings.ai, 
          ...settings.ai,
          features: { ...defaultSettings.ai.features, ...settings.ai?.features },
        },
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

  const updateChunking = (key: string, value: any) => {
    setLocalSettings(prev => ({
      ...prev,
      chunking: { ...prev.chunking, [key]: value },
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
            <TabsList className="grid w-full grid-cols-3 mb-4">
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
            </TabsList>

            <TabsContent value="scraping" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('scrapingSettings')}</CardTitle>
                  <CardDescription>Einstellungen für das Deep Content Scraping</CardDescription>
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
                      Anzahl gleichzeitiger HTTP-Anfragen (1-20)
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
                      Verzögerung zwischen Anfragen zur Serverschonung
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
                    <p className="text-xs text-muted-foreground">CSS-Selektoren für Hauptinhalt (kommasepariert)</p>
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
                    <p className="text-xs text-muted-foreground">CSS-Selektoren für auszuschließende Bereiche</p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="chunking" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('chunkingSettings')}</CardTitle>
                  <CardDescription>Einstellungen für RAG-optimiertes Text-Chunking</CardDescription>
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
                      Optimale Token-Anzahl pro Chunk (Standard: 350)
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
                      Token-Überlappung zwischen Chunks für Kontext
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
                      Mindest-Token pro Chunk (kleinere werden zusammengeführt)
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
                    <p className="text-xs text-muted-foreground">Chunk-Grenzen an diesen Elementen ausrichten</p>
                  </div>

                  <div className="flex items-center justify-between py-2">
                    <div className="space-y-0.5">
                      <Label htmlFor="preserveHeadings">{t('preserveHeadings')}</Label>
                      <p className="text-xs text-muted-foreground">Überschriften-Pfad in jedem Chunk speichern</p>
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
            </TabsContent>

            <TabsContent value="ai" className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('aiSettings')}</CardTitle>
                  <CardDescription>Optionale KI-Funktionen für erweiterte Verarbeitung</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <div className="space-y-0.5">
                      <Label htmlFor="enableAi" className="text-base">{t('enableAi')}</Label>
                      <p className="text-xs text-muted-foreground">Aktiviert KI-basierte Verarbeitungsfunktionen</p>
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
                        <p className="text-xs text-muted-foreground">OpenAI-kompatibler API-Endpunkt</p>
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
                        <p className="text-xs text-muted-foreground">API-Schlüssel für Authentifizierung</p>
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
                        <Label className="text-sm font-medium">KI-Funktionen</Label>
                        
                        <div className="flex items-center justify-between py-2">
                          <div className="space-y-0.5">
                            <Label htmlFor="semanticChunking" className="text-sm">{t('semanticChunking')}</Label>
                            <p className="text-xs text-muted-foreground">KI-basierte Chunk-Grenzen</p>
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
                            <p className="text-xs text-muted-foreground">Zusammenfassung pro Chunk generieren</p>
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
                            <p className="text-xs text-muted-foreground">Keywords pro Chunk extrahieren</p>
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
