import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { History, Download, Trash2, Package, FileText, Layers, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { apiRequest, queryClient } from '@/lib/queryClient';

interface ExportVersion {
  id: number;
  projectId: number;
  downloadId: string;
  filename: string;
  fileSize: number;
  documents: number;
  chunks: number;
  pdfValid: number;
  pdfInvalid: number;
  assets: number;
  createdAt: string;
  expiresAt: string;
}

interface ExportVersionsDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string) {
  return format(new Date(dateStr), "dd.MM.yyyy, HH:mm 'Uhr'", { locale: de });
}

export default function ExportVersionsDialog({ open, onClose, projectId }: ExportVersionsDialogProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const { data: exports = [], isLoading } = useQuery<ExportVersion[]>({
    queryKey: ['/api/projects', projectId, 'exports'],
    enabled: open,
  });

  const deleteMutation = useMutation({
    mutationFn: async (downloadId: string) => {
      await apiRequest('DELETE', `/api/exports/${downloadId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/projects', projectId, 'exports'] });
      setConfirmDeleteId(null);
    },
  });

  const handleDownload = (downloadId: string) => {
    window.open(`/api/rag-pack/download/${downloadId}`, '_blank');
  };

  const handleDelete = (downloadId: string) => {
    if (confirmDeleteId === downloadId) {
      deleteMutation.mutate(downloadId);
    } else {
      setConfirmDeleteId(downloadId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-[520px] w-[520px] max-h-[85vh] flex flex-col" data-testid="export-versions-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-5 h-5 shrink-0" />
            RAG Pack Versionen
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {isLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <div className="animate-pulse space-y-3">
                      <div className="flex justify-between gap-2">
                        <div className="h-4 bg-muted rounded w-40" />
                        <div className="h-4 bg-muted rounded w-20" />
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <div className="h-5 bg-muted rounded w-24" />
                        <div className="h-5 bg-muted rounded w-20" />
                        <div className="h-5 bg-muted rounded w-16" />
                      </div>
                      <div className="h-4 bg-muted rounded w-36" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!isLoading && exports.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground" data-testid="text-no-exports">
              <Package className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-sm">Keine Exporte vorhanden</p>
            </div>
          )}

          {!isLoading && exports.map((exp) => (
            <Card key={exp.id} data-testid={`card-export-${exp.id}`}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-sm font-medium" data-testid={`text-date-${exp.id}`}>
                    {formatDate(exp.createdAt)}
                  </span>
                  <span className="text-sm text-muted-foreground" data-testid={`text-filesize-${exp.id}`}>
                    {formatFileSize(exp.fileSize)}
                  </span>
                </div>

                <div className="flex gap-2 flex-wrap">
                  <Badge variant="secondary" className="gap-1 no-default-hover-elevate">
                    <FileText className="w-3 h-3" />
                    {exp.documents} Dokumente
                  </Badge>
                  <Badge variant="secondary" className="gap-1 no-default-hover-elevate">
                    <Layers className="w-3 h-3" />
                    {exp.chunks} Chunks
                  </Badge>
                  {exp.assets > 0 && (
                    <Badge variant="secondary" className="gap-1 no-default-hover-elevate">
                      {exp.assets} Assets
                    </Badge>
                  )}
                  {exp.pdfValid > 0 && (
                    <Badge variant="secondary" className="gap-1 no-default-hover-elevate">
                      {exp.pdfValid} PDFs
                    </Badge>
                  )}
                </div>

                <p className="text-xs text-muted-foreground" data-testid={`text-expires-${exp.id}`}>
                  Gültig bis: {formatDate(exp.expiresAt)}
                </p>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    onClick={() => handleDownload(exp.downloadId)}
                    data-testid={`button-download-${exp.id}`}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </Button>
                  <Button
                    size="sm"
                    variant={confirmDeleteId === exp.downloadId ? 'destructive' : 'ghost'}
                    onClick={() => handleDelete(exp.downloadId)}
                    disabled={deleteMutation.isPending && confirmDeleteId === exp.downloadId}
                    data-testid={`button-delete-${exp.id}`}
                  >
                    {deleteMutation.isPending && confirmDeleteId === exp.downloadId ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    {confirmDeleteId === exp.downloadId ? 'Wirklich löschen?' : ''}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}