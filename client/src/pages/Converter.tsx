import { useState, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { 
  Upload, Package, Loader2, Download, Trash2, Plus, 
  FileText, File, CheckCircle2, XCircle, RotateCcw, Save,
  Calendar, Archive, FolderOpen, Pencil
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useLanguage } from '@/hooks/use-language';
import { useToast } from '@/hooks/use-toast';

interface UploadedFile {
  name: string;
  size: number;
  type: string;
}

type ConverterPhase = 'idle' | 'uploading' | 'generating' | 'complete' | 'error';

interface GenerateProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
  currentFile?: string;
}

interface GenerateResult {
  downloadId: string;
  filename: string;
  fileSize: number;
  documents: number;
  chunks: number;
  assets: number;
  deduplication?: {
    totalChunks: number;
    exactDuplicates: number;
    nearDuplicates: number;
    uniqueChunks: number;
  };
  embeddings?: {
    successful: number;
    failed: number;
  };
  enrichment?: {
    keywords: number;
    summaries: number;
    categories: number;
    entities: number;
  };
}

interface SavedExport {
  id: number;
  sessionId: string;
  name: string;
  downloadId: string;
  filename: string;
  fileSize: number;
  documents: number;
  chunks: number;
  assets: number;
  sourceFiles: string[];
  createdAt: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return <FileText className="w-4 h-4 text-red-400" />;
  if (['txt', 'md', 'markdown', 'log'].includes(ext)) return <FileText className="w-4 h-4 text-blue-400" />;
  if (['html', 'htm', 'xhtml'].includes(ext)) return <FileText className="w-4 h-4 text-orange-400" />;
  if (['json', 'xml', 'yaml', 'yml', 'csv', 'tsv'].includes(ext)) return <FileText className="w-4 h-4 text-green-400" />;
  return <File className="w-4 h-4 text-muted-foreground" />;
}

export default function Converter() {
  const [, navigate] = useLocation();
  const { language, setLanguage, t } = useLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<ConverterPhase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [progress, setProgress] = useState<GenerateProgress>({ phase: 'idle', current: 0, total: 0, message: '' });
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [renameExportId, setRenameExportId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const { data: savedExports = [], isLoading: exportsLoading } = useQuery<SavedExport[]>({
    queryKey: ['/api/converter/exports'],
  });

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setPhase('uploading');
    setErrorMessage(null);

    const formData = new FormData();
    fileArray.forEach(f => formData.append('files', f));
    if (sessionId) {
      formData.append('sessionId', sessionId);
    }

    try {
      const response = await fetch('/api/converter/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ message: 'Upload failed' }));
        throw new Error(err.message || 'Upload failed');
      }

      const data = await response.json();
      setSessionId(data.sessionId);
      setUploadedFiles(prev => [...prev, ...data.files]);
      setPhase('idle');
      toast({ title: t('filesUploaded'), description: `${data.files.length} ${t('filesUploaded')}` });
    } catch (err) {
      setPhase('error');
      setErrorMessage((err as Error).message);
      toast({ title: t('uploadError'), description: (err as Error).message, variant: 'destructive' });
    }
  }, [t, toast, sessionId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  }, [uploadFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      uploadFiles(e.target.files);
      e.target.value = '';
    }
  }, [uploadFiles]);

  const startGeneration = useCallback(async () => {
    if (!sessionId) return;
    setPhase('generating');
    setErrorMessage(null);
    setIsSaved(false);
    setProgress({ phase: 'init', current: 0, total: 0, message: 'Starte...' });

    try {
      const response = await fetch(`/api/converter/${sessionId}/generate`, { method: 'POST' });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'progress') {
                setProgress({
                  phase: data.phase || 'processing',
                  current: data.current || 0,
                  total: data.total || 0,
                  message: data.message || '',
                  currentFile: data.currentFile,
                });
              } else if (data.type === 'complete') {
                setResult({
                  downloadId: data.downloadId,
                  filename: data.filename,
                  fileSize: data.fileSize,
                  documents: data.documents,
                  chunks: data.chunks,
                  assets: data.assets || 0,
                  deduplication: data.deduplication || undefined,
                  embeddings: data.embeddings || undefined,
                  enrichment: data.enrichment || undefined,
                });
                setPhase('complete');
              } else if (data.type === 'error') {
                throw new Error(data.message || 'Generation failed');
              } else if (data.type === 'init') {
                setProgress({
                  phase: 'init',
                  current: 0,
                  total: data.totalFiles || 0,
                  message: `${data.totalFiles} Dateien werden verarbeitet...`,
                });
              }
            } catch (parseErr) {
              if ((parseErr as Error).message !== 'Generation failed') {
                console.warn('SSE parse error:', parseErr);
              } else {
                throw parseErr;
              }
            }
          }
        }
      }
    } catch (err) {
      setPhase('error');
      setErrorMessage((err as Error).message);
      toast({ title: t('generateError'), description: (err as Error).message, variant: 'destructive' });
    }
  }, [sessionId, t, toast]);

  const saveExport = useCallback(async () => {
    if (!result || !sessionId) return;
    setIsSaving(true);
    try {
      const response = await fetch('/api/converter/exports/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          downloadId: result.downloadId,
          name: result.filename,
        }),
      });
      if (!response.ok) throw new Error('Save failed');
      setIsSaved(true);
      queryClient.invalidateQueries({ queryKey: ['/api/converter/exports'] });
      toast({ title: t('exportSaved'), description: t('savedSuccessfully') });
    } catch (err) {
      toast({ title: t('uploadError'), description: (err as Error).message, variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  }, [result, sessionId, queryClient, t, toast]);

  const deleteExport = useCallback(async (id: number) => {
    try {
      await fetch(`/api/converter/exports/${id}`, { method: 'DELETE' });
      queryClient.invalidateQueries({ queryKey: ['/api/converter/exports'] });
      toast({ title: t('exportDeleted') });
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'destructive' });
    }
  }, [queryClient, t, toast]);

  const renameExport = useCallback(async (id: number, name: string) => {
    try {
      const response = await fetch(`/api/converter/exports/${id}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error('Failed to rename');
      queryClient.invalidateQueries({ queryKey: ['/api/converter/exports'] });
      toast({ title: t('exportRenamed') });
      setRenameExportId(null);
      setRenameValue('');
    } catch (err) {
      toast({ title: 'Error', description: (err as Error).message, variant: 'destructive' });
    }
  }, [queryClient, t, toast]);

  const reloadSession = useCallback(async (exportId: number) => {
    try {
      const response = await fetch(`/api/converter/exports/${exportId}/files`);
      if (!response.ok) throw new Error('Failed to load session');
      const data = await response.json();
      setSessionId(data.sessionId);
      setUploadedFiles(data.files || []);
      setPhase('idle');
      setResult(null);
      setIsSaved(false);
      setErrorMessage(null);
    } catch (err) {
      toast({ title: t('uploadError'), description: (err as Error).message, variant: 'destructive' });
    }
  }, [t, toast]);

  const resetConverter = useCallback(async () => {
    if (sessionId && !isSaved) {
      try {
        await fetch(`/api/converter/${sessionId}`, { method: 'DELETE' });
      } catch {}
    }
    setPhase('idle');
    setSessionId(null);
    setUploadedFiles([]);
    setProgress({ phase: 'idle', current: 0, total: 0, message: '' });
    setResult(null);
    setErrorMessage(null);
    setIsSaved(false);
  }, [sessionId, isSaved]);

  const progressPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="flex h-screen bg-background" data-testid="converter-page">
      <Sidebar
        activeView="converter"
        onNavigate={(view) => {
          if (view === 'dashboard') navigate('/');
          else if (view === 'converter') { /* already here */ }
        }}
        onImport={() => {}}
        t={t}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title={t('ragPackConverter')}
          subtitle={t('converterDescription')}
          language={language}
          onLanguageChange={setLanguage}
          t={t}
        />

        <main className="flex-1 overflow-auto p-6">
          <div className="max-w-3xl mx-auto space-y-6">

            {phase !== 'complete' && (
              <Card>
                <CardContent className="pt-6">
                  <div
                    ref={dropRef}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => phase !== 'generating' && fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all ${
                      isDragging
                        ? 'border-primary bg-primary/5 scale-[1.02]'
                        : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/30'
                    } ${phase === 'generating' ? 'pointer-events-none opacity-50' : ''}`}
                    data-testid="drop-zone"
                  >
                    <Upload className={`w-12 h-12 mx-auto mb-4 ${isDragging ? 'text-primary' : 'text-muted-foreground/50'}`} />
                    <p className="text-lg font-medium text-foreground mb-1">{t('dropFilesHere')}</p>
                    <p className="text-sm text-muted-foreground mb-3">{t('dropFilesDescription')}</p>
                    <p className="text-xs text-muted-foreground/70">{t('supportedFormats')}</p>
                  </div>

                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="hidden"
                    multiple
                    data-testid="file-input"
                  />
                </CardContent>
              </Card>
            )}

            {uploadedFiles.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      {t('uploadedFiles')} ({uploadedFiles.length})
                    </CardTitle>
                    {phase === 'idle' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => fileInputRef.current?.click()}
                        data-testid="button-add-files"
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        {t('addMoreFiles')}
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 max-h-64 overflow-auto">
                    {uploadedFiles.map((file, idx) => (
                      <div
                        key={`${file.name}-${idx}`}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/30"
                        data-testid={`file-item-${idx}`}
                      >
                        {getFileIcon(file.name)}
                        <span className="flex-1 text-sm truncate">{file.name}</span>
                        <Badge variant="outline" className="text-xs shrink-0">
                          {formatFileSize(file.size)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {phase === 'generating' && (
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    <span className="text-sm font-medium">{progress.message}</span>
                  </div>
                  <Progress value={progressPercent} className="h-2" />
                  <p className="text-xs text-muted-foreground text-right">
                    {progress.current}/{progress.total}
                  </p>
                </CardContent>
              </Card>
            )}

            {phase === 'complete' && result && (
              <Card className="border-green-500/30 bg-green-500/5">
                <CardContent className="pt-6 space-y-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-6 h-6 text-green-500" />
                    <div>
                      <p className="font-medium text-foreground">{t('ragPackReady')}</p>
                      <p className="text-sm text-muted-foreground">{result.filename}</p>
                    </div>
                  </div>

                  <div className="flex gap-3 flex-wrap">
                    <Badge variant="secondary">{result.documents} {t('documents')}</Badge>
                    <Badge variant="secondary">{result.chunks} {t('chunks')}</Badge>
                    {result.assets > 0 && <Badge variant="secondary">{result.assets} {t('assets')}</Badge>}
                    <Badge variant="outline">{formatFileSize(result.fileSize)}</Badge>
                  </div>

                  {(result.deduplication || result.embeddings || result.enrichment) && (
                    <div className="space-y-2 text-sm">
                      {result.deduplication && (result.deduplication.exactDuplicates > 0 || result.deduplication.nearDuplicates > 0) && (
                        <div className="flex gap-2 flex-wrap items-center" data-testid="dedup-stats">
                          <span className="text-muted-foreground">{t('deduplication')}:</span>
                          <Badge variant="outline">{result.deduplication.uniqueChunks} {t('uniqueChunks')}</Badge>
                          {result.deduplication.exactDuplicates > 0 && (
                            <Badge variant="destructive">{result.deduplication.exactDuplicates} {t('exactDuplicates')}</Badge>
                          )}
                          {result.deduplication.nearDuplicates > 0 && (
                            <Badge variant="destructive">{result.deduplication.nearDuplicates} {t('nearDuplicates')}</Badge>
                          )}
                        </div>
                      )}
                      {result.embeddings && (
                        <div className="flex gap-2 flex-wrap items-center" data-testid="embeddings-stats">
                          <span className="text-muted-foreground">Embeddings:</span>
                          <Badge variant="secondary">{result.embeddings.successful} {t('generated')}</Badge>
                          {result.embeddings.failed > 0 && (
                            <Badge variant="destructive">{result.embeddings.failed} {t('failed')}</Badge>
                          )}
                        </div>
                      )}
                      {result.enrichment && (
                        <div className="flex gap-2 flex-wrap items-center" data-testid="enrichment-stats">
                          <span className="text-muted-foreground">{t('aiEnrichment')}:</span>
                          {result.enrichment.keywords > 0 && <Badge variant="secondary">{result.enrichment.keywords} Keywords</Badge>}
                          {result.enrichment.summaries > 0 && <Badge variant="secondary">{result.enrichment.summaries} {t('summariesCount')}</Badge>}
                          {result.enrichment.categories > 0 && <Badge variant="secondary">{result.enrichment.categories} {t('categories')}</Badge>}
                          {result.enrichment.entities > 0 && <Badge variant="secondary">{result.enrichment.entities} {t('entities')}</Badge>}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex gap-3 flex-wrap">
                    <Button
                      onClick={() => window.open(`/api/converter/download/${result.downloadId}`, '_blank')}
                      data-testid="button-download-ragpack"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      {t('downloadRagPack')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={saveExport}
                      disabled={isSaving || isSaved}
                      data-testid="button-save-export"
                    >
                      {isSaving ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : isSaved ? (
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                      ) : (
                        <Save className="w-4 h-4 mr-2" />
                      )}
                      {isSaved ? t('exportSaved') : t('saveExport')}
                    </Button>
                    <Button variant="outline" onClick={resetConverter} data-testid="button-reset">
                      <RotateCcw className="w-4 h-4 mr-2" />
                      {t('resetConverter')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {phase === 'error' && errorMessage && (
              <Card className="border-destructive/30 bg-destructive/5">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <XCircle className="w-5 h-5 text-destructive" />
                    <p className="text-sm text-destructive">{errorMessage}</p>
                  </div>
                  <Button variant="outline" size="sm" className="mt-4" onClick={resetConverter}>
                    <RotateCcw className="w-4 h-4 mr-2" />
                    {t('resetConverter')}
                  </Button>
                </CardContent>
              </Card>
            )}

            {uploadedFiles.length > 0 && phase === 'idle' && (
              <div className="flex gap-3">
                <Button
                  onClick={startGeneration}
                  className="flex-1"
                  size="lg"
                  data-testid="button-generate"
                >
                  <Package className="w-5 h-5 mr-2" />
                  {t('generateRagPack')}
                </Button>
                <Button variant="outline" size="lg" onClick={resetConverter} data-testid="button-reset-all">
                  <Trash2 className="w-4 h-4 mr-2" />
                  {t('resetConverter')}
                </Button>
              </div>
            )}

            {phase === 'uploading' && (
              <div className="flex items-center justify-center gap-3 py-4">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">Uploading...</span>
              </div>
            )}

            <Card data-testid="saved-exports-section">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Archive className="w-4 h-4" />
                  {t('savedExports')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {exportsLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : savedExports.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6" data-testid="no-saved-exports">
                    {t('noSavedExports')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {savedExports.map((exp) => (
                      <div
                        key={exp.id}
                        className="border rounded-lg p-4 space-y-3"
                        data-testid={`saved-export-${exp.id}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{exp.name}</p>
                            <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                              <Calendar className="w-3 h-3" />
                              {formatDate(exp.createdAt)}
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => window.open(`/api/converter/download/${exp.downloadId}`, '_blank')}
                              data-testid={`button-download-export-${exp.id}`}
                            >
                              <Download className="w-3.5 h-3.5 mr-1" />
                              {t('downloadRagPack')}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => reloadSession(exp.id)}
                              data-testid={`button-reload-export-${exp.id}`}
                            >
                              <FolderOpen className="w-3.5 h-3.5 mr-1" />
                              {t('addMoreFiles')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setRenameExportId(exp.id);
                                setRenameValue(exp.name);
                              }}
                              data-testid={`button-rename-export-${exp.id}`}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteConfirmId(exp.id)}
                              className="text-destructive hover:text-destructive"
                              data-testid={`button-delete-export-${exp.id}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>

                        <div className="flex gap-2 flex-wrap">
                          <Badge variant="secondary" className="text-xs">{exp.documents} {t('documents')}</Badge>
                          <Badge variant="secondary" className="text-xs">{exp.chunks} {t('chunks')}</Badge>
                          {exp.assets > 0 && <Badge variant="secondary" className="text-xs">{exp.assets} {t('assets')}</Badge>}
                          <Badge variant="outline" className="text-xs">{formatFileSize(exp.fileSize)}</Badge>
                        </div>

                        {exp.sourceFiles && exp.sourceFiles.length > 0 && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">{t('sourceFilesLabel')}:</p>
                            <div className="flex gap-1.5 flex-wrap">
                              {exp.sourceFiles.map((f, i) => (
                                <Badge key={i} variant="outline" className="text-xs font-normal">
                                  {getFileIcon(f)}
                                  <span className="ml-1">{f}</span>
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

          </div>
        </main>
      </div>

      <ConfirmDialog
        open={deleteConfirmId !== null}
        onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}
        title={t('confirmDeleteExport')}
        description={t('confirmDeleteExport')}
        confirmText={t('deleteExport')}
        onConfirm={() => {
          if (deleteConfirmId !== null) {
            deleteExport(deleteConfirmId);
            setDeleteConfirmId(null);
          }
        }}
        variant="destructive"
      />

      <Dialog
        open={renameExportId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameExportId(null);
            setRenameValue('');
          }
        }}
      >
        <DialogContent data-testid="rename-dialog">
          <DialogHeader>
            <DialogTitle>{t('renameExportTitle')}</DialogTitle>
            <DialogDescription>{t('renameExportDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameValue.trim() && renameExportId !== null) {
                renameExport(renameExportId, renameValue.trim());
              }
            }}
            data-testid="input-rename-export"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenameExportId(null);
                setRenameValue('');
              }}
              data-testid="button-cancel-rename"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                if (renameExportId !== null && renameValue.trim()) {
                  renameExport(renameExportId, renameValue.trim());
                }
              }}
              disabled={!renameValue.trim()}
              data-testid="button-confirm-rename"
            >
              {t('renameExport')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
