import { useEffect, useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Loader2, CheckCircle2, XCircle, Download, FileText, Package, HardDrive } from 'lucide-react';

interface RagPackProgressProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  mode: 'project' | 'single-page';
  onComplete?: () => void;
  t: (key: any) => string;
}

type ProgressPhase = 'init' | 'downloading' | 'extracting' | 'building' | 'zipping' | 'complete' | 'error';

interface ProgressData {
  phase: ProgressPhase;
  current: number;
  total: number;
  message: string;
  currentUrl?: string;
  downloadId?: string;
  filename?: string;
  fileSize?: number;
  documents?: number;
  chunks?: number;
  pdfValid?: number;
  pdfInvalid?: number;
  assets?: number;
  error?: string;
  totalDocuments?: number;
  totalPdfs?: number;
}

export default function RagPackProgress({
  open,
  onClose,
  projectId,
  mode,
  onComplete,
  t,
}: RagPackProgressProps) {
  const [progress, setProgress] = useState<ProgressData>({
    phase: 'init',
    current: 0,
    total: 0,
    message: 'Starte Export...',
  });
  const eventSourceRef = useRef<EventSource | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (open && projectId && !startedRef.current) {
      startedRef.current = true;

      const url = mode === 'project'
        ? `/api/projects/${projectId}/rag-pack/stream`
        : `/api/single-pages/${projectId}/rag-pack/stream`;

      let es: EventSource;
      if (mode === 'single-page') {
        fetch(url, { method: 'POST' }).then(async (response) => {
          const reader = response.body?.getReader();
          if (!reader) return;
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
                  handleEvent(data);
                } catch {}
              }
            }
          }
        }).catch((err) => {
          setProgress(prev => ({
            ...prev,
            phase: 'error',
            error: err.message || 'Verbindung fehlgeschlagen',
          }));
        });
      } else {
        es = new EventSource(url);
        eventSourceRef.current = es;

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleEvent(data);
          } catch (err) {
            console.error('Failed to parse SSE data:', err);
          }
        };

        es.onerror = () => {
          setProgress(prev => {
            if (prev.phase !== 'complete' && prev.phase !== 'error') {
              return { ...prev, phase: 'error', error: 'Verbindung zum Server verloren' };
            }
            return prev;
          });
          es.close();
          eventSourceRef.current = null;
        };
      }
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [open, projectId, mode]);

  const handleEvent = (data: any) => {
    if (data.type === 'init') {
      setProgress(prev => ({
        ...prev,
        phase: 'init',
        totalDocuments: data.totalDocuments || data.documents || 0,
        totalPdfs: data.totalPdfs || 0,
        message: `${data.totalDocuments || 1} Dokumente, ${data.totalPdfs || 0} PDFs gefunden`,
      }));
    } else if (data.type === 'progress') {
      setProgress(prev => ({
        ...prev,
        phase: data.phase || 'downloading',
        current: data.current || 0,
        total: data.total || 0,
        currentUrl: data.currentUrl,
        message: data.message || '',
      }));
    } else if (data.type === 'complete') {
      setProgress(prev => ({
        ...prev,
        phase: 'complete',
        downloadId: data.downloadId,
        filename: data.filename,
        fileSize: data.fileSize,
        documents: data.documents,
        chunks: data.chunks,
        pdfValid: data.pdfValid,
        pdfInvalid: data.pdfInvalid,
        assets: data.assets,
        message: 'Export abgeschlossen!',
      }));
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      onComplete?.();
    } else if (data.type === 'error') {
      setProgress(prev => ({
        ...prev,
        phase: 'error',
        error: data.message || 'Unbekannter Fehler',
      }));
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }
  };

  const handleClose = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    startedRef.current = false;
    setProgress({
      phase: 'init',
      current: 0,
      total: 0,
      message: 'Starte Export...',
    });
    onClose();
  };

  const handleDownload = () => {
    if (progress.downloadId) {
      window.open(`/api/rag-pack/download/${progress.downloadId}`, '_blank');
    }
  };

  const getProgressPercent = () => {
    if (progress.phase === 'complete') return 100;
    if (progress.phase === 'init') return 5;
    if (progress.phase === 'zipping') return 90;
    if (progress.phase === 'building') return 80;
    if (progress.total > 0) {
      const phaseBase = progress.phase === 'downloading' ? 10 : 50;
      const phaseRange = progress.phase === 'downloading' ? 40 : 30;
      return Math.round(phaseBase + (progress.current / progress.total) * phaseRange);
    }
    return 15;
  };

  const getPhaseIcon = () => {
    switch (progress.phase) {
      case 'init':
        return <Loader2 className="w-8 h-8 text-primary animate-spin" />;
      case 'downloading':
        return <Download className="w-8 h-8 text-primary animate-pulse" />;
      case 'extracting':
        return <FileText className="w-8 h-8 text-primary animate-pulse" />;
      case 'building':
        return <Package className="w-8 h-8 text-primary animate-pulse" />;
      case 'zipping':
        return <HardDrive className="w-8 h-8 text-primary animate-pulse" />;
      case 'complete':
        return <CheckCircle2 className="w-8 h-8 text-emerald-500" />;
      case 'error':
        return <XCircle className="w-8 h-8 text-destructive" />;
      default:
        return <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />;
    }
  };

  const getPhaseLabel = () => {
    switch (progress.phase) {
      case 'init': return 'Initialisiere...';
      case 'downloading': return 'PDFs herunterladen';
      case 'extracting': return 'PDF-Text extrahieren';
      case 'building': return 'Dokumente erstellen';
      case 'zipping': return 'ZIP erstellen';
      case 'complete': return 'Export abgeschlossen';
      case 'error': return 'Fehler';
      default: return 'Verarbeite...';
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const progressPercent = getProgressPercent();

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg w-[480px] max-h-[90vh] overflow-y-auto overflow-x-hidden" data-testid="ragpack-progress-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="w-5 h-5" />
            RAG Pack Export
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="flex flex-col items-center gap-3">
            {getPhaseIcon()}
            <p className="text-sm font-medium text-foreground text-center">
              {getPhaseLabel()}
            </p>
            <p className="text-xs text-muted-foreground text-center">
              {progress.message}
            </p>
          </div>

          {progress.phase !== 'complete' && progress.phase !== 'error' && (
            <div className="space-y-2">
              <Progress value={progressPercent} className="h-3" data-testid="progress-bar" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {progress.phase === 'downloading' && progress.total > 0
                    ? `PDF ${progress.current}/${progress.total}`
                    : progress.phase === 'extracting' && progress.total > 0
                    ? `${progress.current}/${progress.total} PDFs`
                    : getPhaseLabel()
                  }
                </span>
                <span>{progressPercent}%</span>
              </div>
            </div>
          )}

          {progress.currentUrl && progress.phase !== 'complete' && progress.phase !== 'error' && (
            <div className="text-xs text-muted-foreground bg-secondary p-2 rounded overflow-hidden max-w-full min-w-0">
              <span className="font-medium">Aktuell: </span>
              <span className="block truncate max-w-full">{progress.currentUrl}</span>
            </div>
          )}

          {progress.phase === 'complete' && (
            <>
              <div className="bg-secondary rounded-lg p-4">
                <div className="grid grid-cols-2 gap-4 text-center">
                  <div>
                    <p className="text-2xl font-bold text-foreground" data-testid="text-document-count">{progress.documents || 0}</p>
                    <p className="text-xs text-muted-foreground">Dokumente</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground" data-testid="text-chunk-count">{progress.chunks || 0}</p>
                    <p className="text-xs text-muted-foreground">Chunks</p>
                  </div>
                </div>
                {((progress.pdfValid || 0) > 0 || (progress.pdfInvalid || 0) > 0) && (
                  <div className="grid grid-cols-3 gap-4 text-center mt-4 pt-4 border-t border-border">
                    <div>
                      <p className="text-lg font-bold text-foreground">{progress.assets || 0}</p>
                      <p className="text-xs text-muted-foreground">Assets</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-emerald-500">{progress.pdfValid || 0}</p>
                      <p className="text-xs text-muted-foreground">PDFs mit Text</p>
                    </div>
                    <div>
                      <p className="text-lg font-bold text-amber-500">{progress.pdfInvalid || 0}</p>
                      <p className="text-xs text-muted-foreground">Binär-PDFs</p>
                    </div>
                  </div>
                )}
                {progress.fileSize && (
                  <div className="text-center mt-4 pt-4 border-t border-border">
                    <p className="text-sm text-muted-foreground">
                      Dateigröße: <span className="font-medium text-foreground">{formatFileSize(progress.fileSize)}</span>
                    </p>
                  </div>
                )}
              </div>

              <Button
                onClick={handleDownload}
                className="w-full gap-2"
                data-testid="button-download-ragpack"
              >
                <Download className="w-4 h-4 shrink-0" />
                <span className="truncate">
                  {progress.filename
                    ? (progress.filename.length > 40 
                        ? progress.filename.slice(0, 37) + '...zip' 
                        : progress.filename)
                    : 'RAG Pack herunterladen'}
                </span>
              </Button>
            </>
          )}

          {progress.phase === 'error' && (
            <div className="text-sm bg-destructive/10 text-destructive p-3 rounded border border-destructive/20">
              {progress.error || 'Ein unbekannter Fehler ist aufgetreten'}
            </div>
          )}

          <div className="flex justify-end gap-2">
            {(progress.phase === 'complete' || progress.phase === 'error') && (
              <Button
                variant="outline"
                onClick={handleClose}
                data-testid="button-close-ragpack"
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
