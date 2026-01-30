import { useState, useEffect } from 'react';
import { X, FileText, Hash, Copy, Check, Loader2, ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
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

function formatChunkText(text: string) {
  const paragraphs = text.split(/\n\n+/);
  return paragraphs.map((p, i) => {
    const trimmed = p.trim();
    if (!trimmed) return null;
    
    if (trimmed.startsWith('#')) {
      const level = trimmed.match(/^#+/)?.[0].length || 1;
      const content = trimmed.replace(/^#+\s*/, '');
      const sizes: Record<number, string> = {
        1: 'text-xl font-bold mt-4 mb-2',
        2: 'text-lg font-bold mt-3 mb-2',
        3: 'text-base font-semibold mt-2 mb-1',
      };
      return (
        <div key={i} className={sizes[Math.min(level, 3)] || sizes[3]}>
          {content}
        </div>
      );
    }
    
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const items = trimmed.split('\n').filter(l => l.trim());
      return (
        <ul key={i} className="list-disc pl-5 mb-3 space-y-1 text-sm text-muted-foreground">
          {items.map((item, j) => (
            <li key={j}>{item.replace(/^[-*]\s*/, '')}</li>
          ))}
        </ul>
      );
    }
    
    return (
      <p key={i} className="text-sm text-muted-foreground leading-relaxed mb-3">
        {trimmed}
      </p>
    );
  });
}

export default function ChunksPreview({ url, projectId, onClose, t }: ChunksPreviewProps) {
  const [chunks, setChunks] = useState<RagChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<number>(0);
  const [viewMode, setViewMode] = useState<'content' | 'raw'>('content');

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

  const handleCopyAll = async () => {
    const allText = chunks.map(c => c.text).join('\n\n---\n\n');
    const success = await copyToClipboard(allText);
    if (success) {
      setCopied('all');
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const handleCopyChunk = async () => {
    if (!currentChunk) return;
    const success = await copyToClipboard(currentChunk.text);
    if (success) {
      setCopied('chunk');
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const currentChunk = chunks[selectedChunk];
  const urlPath = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();

  return (
    <div 
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      data-testid="chunks-preview-overlay"
    >
      <div 
        className="bg-card border border-border rounded-xl w-full max-w-6xl h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <FileText className="w-5 h-5 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-foreground truncate">Inhalt Vorschau</h3>
              <p className="text-xs text-muted-foreground truncate">{urlPath}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyAll}
              className="gap-1.5"
            >
              {copied === 'all' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              Alle kopieren
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              data-testid="close-chunks-preview"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-destructive">{error}</p>
          </div>
        ) : chunks.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-muted-foreground">Keine Chunks für diese URL gefunden</p>
          </div>
        ) : (
          <div className="flex-1 flex min-h-0">
            <div className="w-64 border-r border-border flex flex-col shrink-0">
              <div className="p-3 border-b border-border bg-muted/30">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Layers className="w-4 h-4 text-muted-foreground" />
                  <span>{chunks.length} Chunks</span>
                </div>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2 space-y-1">
                  {chunks.map((chunk, idx) => (
                    <button
                      key={idx}
                      onClick={() => setSelectedChunk(idx)}
                      className={`w-full text-left p-2 rounded-lg transition-colors text-xs ${
                        idx === selectedChunk
                          ? 'bg-primary/10 border border-primary/30'
                          : 'hover:bg-muted/50 border border-transparent'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-foreground">Chunk {idx + 1}</span>
                        <span className="text-muted-foreground">
                          {chunk.tokens_estimate || chunk.quality?.tokenCount || 0} T
                        </span>
                      </div>
                      <p className="text-muted-foreground line-clamp-2 leading-tight">
                        {chunk.text.substring(0, 80)}...
                      </p>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>

            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30 shrink-0">
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setSelectedChunk(Math.max(0, selectedChunk - 1))}
                      disabled={selectedChunk === 0}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span className="text-sm font-medium min-w-[80px] text-center">
                      {selectedChunk + 1} / {chunks.length}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setSelectedChunk(Math.min(chunks.length - 1, selectedChunk + 1))}
                      disabled={selectedChunk === chunks.length - 1}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                  
                  {currentChunk?.location?.heading_path && currentChunk.location.heading_path.length > 0 && (
                    <div className="text-xs text-muted-foreground border-l border-border pl-4">
                      {currentChunk.location.heading_path.join(' › ')}
                    </div>
                  )}
                </div>
                
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    <button
                      onClick={() => setViewMode('content')}
                      className={`px-3 py-1 text-xs font-medium transition-colors ${
                        viewMode === 'content' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                      }`}
                    >
                      Formatiert
                    </button>
                    <button
                      onClick={() => setViewMode('raw')}
                      className={`px-3 py-1 text-xs font-medium transition-colors ${
                        viewMode === 'raw' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                      }`}
                    >
                      Roh
                    </button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopyChunk}
                    className="h-7 gap-1"
                  >
                    {copied === 'chunk' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </Button>
                </div>
              </div>

              <ScrollArea className="flex-1">
                <div className="p-6">
                  {currentChunk && (
                    <>
                      {viewMode === 'content' ? (
                        <div className="prose prose-sm max-w-none dark:prose-invert">
                          {formatChunkText(currentChunk.text)}
                        </div>
                      ) : (
                        <pre className="whitespace-pre-wrap text-sm font-mono text-foreground bg-muted/30 rounded-lg p-4">
                          {currentChunk.text}
                        </pre>
                      )}

                      <div className="mt-6 pt-4 border-t border-border">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                          <div className="bg-muted/30 rounded-lg p-3">
                            <span className="text-muted-foreground block mb-1">Typ</span>
                            <span className="font-medium">{currentChunk.chunk_type || 'text'}</span>
                          </div>
                          <div className="bg-muted/30 rounded-lg p-3">
                            <span className="text-muted-foreground block mb-1">Tokens</span>
                            <span className="font-medium">
                              {currentChunk.tokens_estimate || currentChunk.quality?.tokenCount || 0}
                            </span>
                          </div>
                          <div className="bg-muted/30 rounded-lg p-3">
                            <span className="text-muted-foreground block mb-1">Qualität</span>
                            <span className={`font-medium ${
                              currentChunk.quality?.quality === 'good' ? 'text-green-500' :
                              currentChunk.quality?.quality === 'warning' ? 'text-yellow-500' :
                              currentChunk.quality?.quality === 'poor' ? 'text-red-500' : ''
                            }`}>
                              {currentChunk.quality?.quality || 'N/A'}
                            </span>
                          </div>
                          <div className="bg-muted/30 rounded-lg p-3">
                            <span className="text-muted-foreground block mb-1">Sprache</span>
                            <span className="font-medium">{currentChunk.language || 'de'}</span>
                          </div>
                        </div>

                        {currentChunk.ai_metadata?.keywords && currentChunk.ai_metadata.keywords.length > 0 && (
                          <div className="mt-4">
                            <span className="text-xs text-muted-foreground block mb-2">Keywords</span>
                            <div className="flex flex-wrap gap-1.5">
                              {currentChunk.ai_metadata.keywords.map((kw, i) => (
                                <span key={i} className="px-2 py-0.5 bg-primary/10 text-primary rounded text-xs">
                                  {kw}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {currentChunk.ai_metadata?.summary && (
                          <div className="mt-4">
                            <span className="text-xs text-muted-foreground block mb-2">Zusammenfassung</span>
                            <p className="text-sm text-foreground bg-muted/30 rounded-lg p-3">
                              {currentChunk.ai_metadata.summary}
                            </p>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
