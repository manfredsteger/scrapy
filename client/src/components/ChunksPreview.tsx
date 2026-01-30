import { useState, useEffect } from 'react';
import { X, FileText, Hash, Copy, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RagChunk } from '@shared/schema';

interface ChunksPreviewProps {
  url: string;
  projectId: number;
  onClose: () => void;
  t: (key: any) => string;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
    }
  }
  
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  
  try {
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return true;
  } catch {
    document.body.removeChild(textarea);
    return false;
  }
}

export default function ChunksPreview({ url, projectId, onClose, t }: ChunksPreviewProps) {
  const [chunks, setChunks] = useState<RagChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<number>(0);

  useEffect(() => {
    const fetchChunks = async () => {
      try {
        setLoading(true);
        const response = await fetch(
          `/api/projects/${projectId}/chunks/by-url?url=${encodeURIComponent(url)}`
        );
        if (!response.ok) {
          throw new Error('Failed to fetch chunks');
        }
        const data = await response.json();
        setChunks(data.chunks || []);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    };

    fetchChunks();
  }, [url, projectId]);

  const handleCopy = async (text: string, type: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const currentChunk = chunks[selectedChunk];

  return (
    <div 
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      data-testid="chunks-preview-overlay"
    >
      <div 
        className="bg-card border border-border rounded-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground truncate">Chunks Preview</h3>
              <p className="text-xs text-muted-foreground truncate">{url}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            data-testid="close-chunks-preview"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="text-destructive">{error}</p>
          </div>
        ) : chunks.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="text-muted-foreground">Keine Chunks für diese URL gefunden</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30 shrink-0">
              <div className="flex items-center gap-2">
                <Hash className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  Chunk {selectedChunk + 1} von {chunks.length}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({currentChunk?.tokens_estimate || currentChunk?.quality?.tokenCount || 0} Tokens)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedChunk(Math.max(0, selectedChunk - 1))}
                  disabled={selectedChunk === 0}
                >
                  Zurück
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedChunk(Math.min(chunks.length - 1, selectedChunk + 1))}
                  disabled={selectedChunk === chunks.length - 1}
                >
                  Weiter
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {currentChunk && (
                <div className="space-y-4">
                  {currentChunk.location?.heading_path && currentChunk.location.heading_path.length > 0 && (
                    <div className="text-sm text-muted-foreground">
                      <span className="font-medium">Überschriften:</span>{' '}
                      {currentChunk.location.heading_path.join(' > ')}
                    </div>
                  )}
                  
                  <div className="bg-muted/30 rounded-lg p-4 relative group">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleCopy(currentChunk.text, 'text')}
                    >
                      {copied === 'text' ? (
                        <Check className="w-4 h-4 text-green-500" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                    <pre className="whitespace-pre-wrap text-sm font-mono text-foreground">
                      {currentChunk.text}
                    </pre>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Typ:</span>{' '}
                      <span className="font-medium">{currentChunk.chunk_type || 'text'}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Qualität:</span>{' '}
                      <span className="font-medium">{currentChunk.quality?.quality || 'N/A'}</span>
                    </div>
                    {currentChunk.ai_metadata?.keywords && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Keywords:</span>{' '}
                        <span className="font-medium">
                          {currentChunk.ai_metadata.keywords.join(', ')}
                        </span>
                      </div>
                    )}
                    {currentChunk.ai_metadata?.summary && (
                      <div className="col-span-2">
                        <span className="text-muted-foreground">Zusammenfassung:</span>{' '}
                        <span className="font-medium">{currentChunk.ai_metadata.summary}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-1 px-4 py-2 border-t border-border bg-muted/30 shrink-0 max-h-24 overflow-auto">
              {chunks.map((_, idx) => (
                <Button
                  key={idx}
                  variant={idx === selectedChunk ? 'default' : 'outline'}
                  size="sm"
                  className="w-8 h-8 p-0"
                  onClick={() => setSelectedChunk(idx)}
                >
                  {idx + 1}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
