import { useEffect, useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2, XCircle, X } from 'lucide-react';

interface ChunkingProgressProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  totalPages: number;
  onComplete: (result: { chunksGenerated: number; pagesProcessed: number }) => void;
  t: (key: any) => string;
}

type ProgressStatus = 'idle' | 'processing' | 'completed' | 'error' | 'cancelled';

interface EmbeddingsProgress {
  processed: number;
  total: number;
  successful: number;
  failed: number;
}

interface EnrichmentProgress {
  processed: number;
  total: number;
  successful: number;
  failed: number;
}

interface ProgressData {
  status: ProgressStatus;
  current: number;
  total: number;
  chunksGenerated: number;
  currentUrl?: string;
  error?: string;
  phase?: 'chunking' | 'deduplication' | 'embeddings' | 'enrichment';
  embeddingsProgress?: EmbeddingsProgress;
  enrichmentProgress?: EnrichmentProgress;
  warningMessage?: string;
}

export default function ChunkingProgress({ 
  open, 
  onClose, 
  projectId, 
  totalPages,
  onComplete,
  t 
}: ChunkingProgressProps) {
  const [progress, setProgress] = useState<ProgressData>({
    status: 'idle',
    current: 0,
    total: totalPages,
    chunksGenerated: 0,
  });
  const eventSourceRef = useRef<EventSource | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (open && projectId && !startedRef.current) {
      startedRef.current = true;
      const es = new EventSource(`/api/projects/${projectId}/chunks/stream`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'progress') {
            setProgress(prev => ({
              ...prev,
              status: 'processing',
              current: data.current,
              total: data.total,
              chunksGenerated: data.chunksGenerated,
              currentUrl: data.currentUrl,
              phase: data.phase || 'chunking',
              embeddingsProgress: data.embeddingsProgress,
              enrichmentProgress: data.enrichmentProgress,
            }));
          } else if (data.type === 'warning') {
            setProgress(prev => ({
              ...prev,
              warningMessage: data.message,
            }));
          } else if (data.type === 'complete') {
            setProgress(prev => ({
              ...prev,
              status: 'completed',
              current: data.total,
              total: data.total,
              chunksGenerated: data.chunksGenerated,
            }));
            es.close();
            eventSourceRef.current = null;
            onComplete({ 
              chunksGenerated: data.chunksGenerated, 
              pagesProcessed: data.pagesProcessed 
            });
          } else if (data.type === 'error') {
            setProgress(prev => ({
              ...prev,
              status: 'error',
              error: data.message,
            }));
            es.close();
            eventSourceRef.current = null;
          } else if (data.type === 'cancelled') {
            setProgress(prev => ({
              ...prev,
              status: 'cancelled',
              chunksGenerated: data.chunksGenerated || prev.chunksGenerated,
            }));
            es.close();
            eventSourceRef.current = null;
          }
        } catch (err) {
          console.error('Failed to parse SSE data:', err);
        }
      };

      es.onerror = () => {
        setProgress(prev => {
          if (prev.status !== 'completed' && prev.status !== 'cancelled') {
            return {
              ...prev,
              status: 'error',
              error: 'Verbindung zum Server verloren',
            };
          }
          return prev;
        });
        es.close();
        eventSourceRef.current = null;
      };
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [open, projectId, onComplete]);

  const handleCancel = async () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    try {
      await fetch(`/api/projects/${projectId}/chunks/cancel`, { method: 'POST' });
    } catch {}
    setProgress(prev => ({ ...prev, status: 'cancelled' }));
  };

  const handleClose = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    startedRef.current = false;
    setProgress({
      status: 'idle',
      current: 0,
      total: totalPages,
      chunksGenerated: 0,
    });
    onClose();
  };

  const progressPercent = progress.total > 0 
    ? Math.round((progress.current / progress.total) * 100) 
    : 0;

  const getStatusIcon = () => {
    switch (progress.status) {
      case 'processing':
        return <Loader2 className="w-8 h-8 text-primary animate-spin" />;
      case 'completed':
        return <CheckCircle2 className="w-8 h-8 text-emerald-500" />;
      case 'error':
      case 'cancelled':
        return <XCircle className="w-8 h-8 text-destructive" />;
      default:
        return <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />;
    }
  };

  const getStatusText = () => {
    switch (progress.status) {
      case 'idle':
        return 'Starte Verarbeitung...';
      case 'processing':
        if (progress.phase === 'enrichment') {
          const enr = progress.enrichmentProgress;
          if (enr) {
            return `Anreichere Metadaten (${enr.processed}/${enr.total})`;
          }
          return 'Anreichere Metadaten...';
        }
        if (progress.phase === 'embeddings') {
          const ep = progress.embeddingsProgress;
          if (ep) {
            return `Generiere Embeddings (${ep.processed}/${ep.total})`;
          }
          return 'Generiere Embeddings...';
        }
        if (progress.phase === 'deduplication') {
          return 'Dedupliziere Chunks...';
        }
        return `Verarbeite Seite ${progress.current} von ${progress.total}`;
      case 'completed':
        return `Fertig! ${progress.chunksGenerated} Chunks generiert`;
      case 'cancelled':
        return 'Abgebrochen';
      case 'error':
        return progress.error || 'Fehler aufgetreten';
      default:
        return '';
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md w-[400px]" data-testid="chunking-progress-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('generateChunks')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="flex flex-col items-center gap-4">
            {getStatusIcon()}
            <p className="text-sm text-muted-foreground text-center">
              {getStatusText()}
            </p>
          </div>

          <div className="space-y-2">
            <Progress value={progressPercent} className="h-3" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{progress.current} / {progress.total} Seiten</span>
              <span>{progressPercent}%</span>
            </div>
          </div>

          {progress.currentUrl && progress.status === 'processing' && (
            <div className="text-xs text-muted-foreground bg-secondary p-2 rounded w-full max-w-full overflow-hidden">
              <span className="font-medium">Aktuelle URL: </span>
              <span className="block truncate w-full" style={{ maxWidth: '100%' }}>{progress.currentUrl}</span>
            </div>
          )}

          {progress.warningMessage && (
            <div className="text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 p-2 rounded border border-amber-500/20">
              {progress.warningMessage}
            </div>
          )}

          <div className="bg-secondary rounded-lg p-4">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-foreground">{progress.chunksGenerated}</p>
                <p className="text-xs text-muted-foreground">Chunks generiert</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-foreground">{progress.current}</p>
                <p className="text-xs text-muted-foreground">Seiten verarbeitet</p>
              </div>
            </div>
            {progress.phase === 'embeddings' && progress.embeddingsProgress && (
              <div className="grid grid-cols-2 gap-4 text-center mt-4 pt-4 border-t border-border">
                <div>
                  <p className="text-xl font-bold text-emerald-500">{progress.embeddingsProgress.successful}</p>
                  <p className="text-xs text-muted-foreground">Embeddings erfolgreich</p>
                </div>
                <div>
                  <p className="text-xl font-bold text-destructive">{progress.embeddingsProgress.failed}</p>
                  <p className="text-xs text-muted-foreground">Embeddings fehlgeschlagen</p>
                </div>
              </div>
            )}
            {progress.phase === 'enrichment' && progress.enrichmentProgress && (
              <div className="grid grid-cols-2 gap-4 text-center mt-4 pt-4 border-t border-border">
                <div>
                  <p className="text-xl font-bold text-emerald-500">{progress.enrichmentProgress.successful}</p>
                  <p className="text-xs text-muted-foreground">Metadaten erfolgreich</p>
                </div>
                <div>
                  <p className="text-xl font-bold text-destructive">{progress.enrichmentProgress.failed}</p>
                  <p className="text-xs text-muted-foreground">Metadaten fehlgeschlagen</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            {progress.status === 'processing' && (
              <Button 
                variant="outline" 
                onClick={handleCancel}
                data-testid="button-cancel-chunking"
              >
                <X className="w-4 h-4 mr-2" />
                Abbrechen
              </Button>
            )}
            {(progress.status === 'completed' || progress.status === 'error' || progress.status === 'cancelled') && (
              <Button 
                onClick={handleClose}
                data-testid="button-close-chunking"
              >
                {t('close')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
