import { useState } from 'react';
import { useRoute, useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { queryClient, apiRequest } from '@/lib/queryClient';
import { 
  ArrowLeft, Download, FileText, Image as ImageIcon, Video, Layers,
  Loader2, AlertCircle, ExternalLink, RefreshCw, Settings, MoreVertical, Trash2, Package,
  Copy, Check, Tag, Sparkles
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/hooks/use-language';
import type { SinglePage, ScrapedElement, RagChunk } from '@shared/schema';

// Markdown conversion helpers
function elementToMarkdown(el: ScrapedElement): string {
  if (el.type === 'heading') {
    const level = parseInt(el.tag?.replace('h', '') || '2');
    return '#'.repeat(level) + ' ' + el.content + '\n\n';
  }
  if (el.type === 'paragraph') {
    return el.content + '\n\n';
  }
  if (el.type === 'list') {
    const items = (el.children as string[] || []);
    const prefix = el.tag === 'ol' ? (i: number) => `${i + 1}. ` : () => '- ';
    return items.map((item, i) => prefix(i) + item).join('\n') + '\n\n';
  }
  if (el.type === 'blockquote') {
    return '> ' + el.content + '\n\n';
  }
  if (el.type === 'code') {
    return '```\n' + el.content + '\n```\n\n';
  }
  if (el.type === 'media') {
    return el.tag === 'img' ? `![](${el.src})\n\n` : `[Video](${el.src})\n\n`;
  }
  if (el.type === 'table') {
    const headers = (el as any).headers as string[] || [];
    const rows = (el as any).rows as string[][] || el.children as string[][] || [];
    let md = '';
    if (headers.length > 0) {
      md += '| ' + headers.join(' | ') + ' |\n';
      md += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
    }
    rows.forEach(row => {
      if (Array.isArray(row)) {
        md += '| ' + row.join(' | ') + ' |\n';
      }
    });
    return md + '\n';
  }
  return '';
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
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

function renderElement(el: ScrapedElement, idx: number) {
  if (el.type === 'heading') {
    const sizes: Record<string, string> = {
      h1: 'text-2xl font-bold mt-6 mb-3',
      h2: 'text-xl font-bold mt-5 mb-2',
      h3: 'text-lg font-semibold mt-4 mb-2',
      h4: 'text-base font-semibold mt-3 mb-1',
      h5: 'text-sm font-medium mt-2 mb-1',
      h6: 'text-sm font-medium mt-2 mb-1',
    };
    const sizeClass = sizes[el.tag || 'h2'] || sizes.h2;
    return (
      <div key={idx} className={`${sizeClass} text-foreground`}>
        {el.content}
      </div>
    );
  }
  
  if (el.type === 'paragraph') {
    return (
      <p key={idx} className="text-sm text-muted-foreground leading-relaxed mb-3">
        {el.content}
      </p>
    );
  }
  
  if (el.type === 'list') {
    const Tag = el.tag === 'ol' ? 'ol' : 'ul';
    const listStyle = el.tag === 'ol' ? 'list-decimal' : 'list-disc';
    return (
      <Tag key={idx} className={`${listStyle} pl-5 mb-3 space-y-1 text-sm text-muted-foreground`}>
        {(el.children as string[] || []).map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </Tag>
    );
  }
  
  if (el.type === 'blockquote') {
    return (
      <blockquote key={idx} className="border-l-2 border-primary/50 pl-4 py-1 mb-3 text-sm text-muted-foreground italic">
        {el.content}
      </blockquote>
    );
  }
  
  if (el.type === 'code') {
    return (
      <pre key={idx} className="bg-secondary p-3 rounded-lg mb-3 overflow-x-auto text-xs font-mono text-foreground">
        <code>{el.content}</code>
      </pre>
    );
  }
  
  if (el.type === 'table' && el.children) {
    const rows = el.children as string[][];
    return (
      <div key={idx} className="overflow-x-auto mb-3 rounded-lg border border-border">
        <table className="w-full text-sm">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? 'bg-secondary font-medium' : 'border-t border-border'}>
                {row.map((cell, ci) => (
                  <td key={ci} className="px-3 py-2">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  
  if (el.type === 'media') {
    return (
      <div key={idx} className="my-4 bg-secondary rounded-lg p-4 flex items-center gap-3">
        {el.tag === 'img' ? (
          <ImageIcon className="w-5 h-5 text-purple-400 shrink-0" />
        ) : (
          <Video className="w-5 h-5 text-orange-400 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground uppercase">{el.tag === 'img' ? 'Image' : 'Video'}</p>
          <a 
            href={el.src} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-xs text-primary truncate block hover:underline"
          >
            {el.src}
          </a>
        </div>
      </div>
    );
  }
  
  return null;
}

export default function SinglePageDetail() {
  const [, params] = useRoute('/single-page/:id');
  const [, navigate] = useLocation();
  const { t, language } = useLanguage();
  const id = params?.id;
  const [copied, setCopied] = useState<string | null>(null);
  const [copiedChunk, setCopiedChunk] = useState<number | null>(null);
  const [expandedChunk, setExpandedChunk] = useState<number | null>(null);

  const { data: page, isLoading, error, refetch } = useQuery<SinglePage>({
    queryKey: ['/api/single-pages', id],
    enabled: !!id,
  });

  // Format single chunk as Markdown
  const chunkToMarkdown = (chunk: RagChunk, idx: number): string => {
    let md = `## Chunk ${idx + 1}\n\n`;
    if (chunk.structure?.heading) {
      md += `**Heading:** ${chunk.structure.heading}\n\n`;
    }
    md += chunk.text + '\n\n';
    md += `---\n`;
    md += `- **Tokens:** ~${chunk.tokens_estimate}\n`;
    if (chunk.quality) {
      md += `- **Quality:** ${chunk.quality.quality}\n`;
    }
    if (chunk.ai_metadata?.keywords && chunk.ai_metadata.keywords.length > 0) {
      md += `- **Keywords:** ${chunk.ai_metadata.keywords.join(', ')}\n`;
    }
    if (chunk.ai_metadata?.summary) {
      md += `- **Summary:** ${chunk.ai_metadata.summary}\n`;
    }
    md += '\n';
    return md;
  };

  // Copy single chunk
  const copySingleChunk = async (chunk: RagChunk, idx: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const md = chunkToMarkdown(chunk, idx);
    const success = await copyToClipboard(md);
    if (success) {
      setCopiedChunk(idx);
      setTimeout(() => setCopiedChunk(null), 2000);
    }
  };

  // Copy all chunks
  const copyAllChunks = async () => {
    if (!page) return;
    const chunks = page.chunks || [];
    let md = `# RAG Chunks für ${page.url}\n\n`;
    md += `Gesamt: ${chunks.length} Chunks\n\n---\n\n`;
    chunks.forEach((chunk, idx) => {
      md += chunkToMarkdown(chunk, idx);
    });
    const success = await copyToClipboard(md);
    if (success) {
      setCopied('chunks');
      setTimeout(() => setCopied(null), 2000);
    }
  };

  // Copy content as Markdown
  const copyContentMarkdown = async () => {
    if (!page?.scrapedData) return;
    let content = `# ${page.title || page.url}\n\n`;
    content += page.scrapedData.orderedElements.map(elementToMarkdown).join('');
    const success = await copyToClipboard(content);
    if (success) {
      setCopied('content');
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('DELETE', `/api/single-pages/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/single-pages'] });
      navigate('/');
    },
  });

  const reScrape = async () => {
    if (!page) return;
    await deleteMutation.mutateAsync();
    await apiRequest('POST', '/api/single-pages', { url: page.url });
    queryClient.invalidateQueries({ queryKey: ['/api/single-pages'] });
    navigate('/');
  };

  const openOriginal = () => {
    if (page?.url) {
      window.open(page.url, '_blank', 'noopener,noreferrer');
    }
  };

  const exportJson = () => {
    if (!page) return;
    const data = {
      url: page.url,
      title: page.title,
      domain: page.domain,
      wordCount: page.wordCount,
      imageCount: page.imageCount,
      videoCount: page.videoCount,
      scrapedData: page.scrapedData,
      chunks: page.chunks,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `single-page-${page.domain}-${page.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    if (!page || !page.chunks) return;
    const headers = ['chunk_id', 'text', 'tokens_estimate', 'chunk_type', 'quality'];
    const rows = page.chunks.map(chunk => [
      chunk.chunk_id,
      `"${(chunk.text || '').replace(/"/g, '""')}"`,
      chunk.tokens_estimate,
      chunk.chunk_type || 'text',
      chunk.quality?.quality || 'N/A',
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `single-page-chunks-${page.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <AlertCircle className="w-12 h-12 text-destructive" />
        <p className="text-muted-foreground">{t('error')}: Page not found</p>
        <Button variant="outline" onClick={() => navigate('/')} className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          {t('recentProjects')}
        </Button>
      </div>
    );
  }

  const chunks = page.chunks || [];
  const elements = page.scrapedData?.orderedElements || [];

  return (
    <div className="flex-1 flex flex-col min-h-0 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => navigate('/')}
            className="gap-2 -ml-2"
            data-testid="back-button"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('recentProjects')}
          </Button>
          <div className="h-6 w-px bg-border" />
          <div>
            <h1 className="text-xl font-semibold text-foreground truncate max-w-xl" data-testid="page-title">
              {page.title || page.url}
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary" className="text-xs" data-testid="domain-badge">
                {page.domain}
              </Badge>
              <Badge 
                variant={page.status === 'completed' ? 'default' : page.status === 'error' ? 'destructive' : 'secondary'}
                className="text-xs"
                data-testid="status-badge"
              >
                {page.status}
              </Badge>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={openOriginal}
            className="gap-2"
            data-testid="button-open-original"
          >
            <ExternalLink className="w-4 h-4" />
            {t('openOriginal')}
          </Button>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" data-testid="action-menu">
                <MoreVertical className="w-4 h-4" />
                {t('actionsMenu')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => refetch()} className="gap-2" data-testid="action-refresh">
                <RefreshCw className="w-4 h-4" />
                {t('refresh')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={reScrape} className="gap-2" data-testid="action-rescrape">
                <RefreshCw className="w-4 h-4" />
                {t('reScrape')}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => window.open(`/api/single-pages/${id}/rag-pack`, '_blank')} 
                className="gap-2" 
                data-testid="action-save-ragpack"
              >
                <Package className="w-4 h-4" />
                {t('exportRagPack')}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => {
                  if (confirm(t('confirmDelete'))) {
                    deleteMutation.mutate();
                  }
                }} 
                className="gap-2 text-destructive focus:text-destructive"
                data-testid="action-delete"
              >
                <Trash2 className="w-4 h-4" />
                {t('delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" data-testid="export-dropdown">
                <Download className="w-4 h-4" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={exportJson} className="gap-2" data-testid="export-json">
                <Download className="w-4 h-4" />
                {t('exportJson')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={exportCsv} className="gap-2" data-testid="export-csv">
                <Download className="w-4 h-4" />
                {t('exportCsv')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="stat-card-green rounded-xl p-4" data-testid="stat-words">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('totalWords')}</p>
              <p className="text-3xl font-bold mt-1">{(page.wordCount || 0).toLocaleString()}</p>
            </div>
            <FileText className="w-6 h-6 opacity-60" />
          </div>
        </div>
        
        <div className="stat-card-purple rounded-xl p-4" data-testid="stat-images">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('images')}</p>
              <p className="text-3xl font-bold mt-1">{(page.imageCount || 0).toLocaleString()}</p>
            </div>
            <ImageIcon className="w-6 h-6 opacity-60" />
          </div>
        </div>
        
        <div className="stat-card-orange rounded-xl p-4" data-testid="stat-videos">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('videos')}</p>
              <p className="text-3xl font-bold mt-1">{(page.videoCount || 0).toLocaleString()}</p>
            </div>
            <Video className="w-6 h-6 opacity-60" />
          </div>
        </div>
        
        <div className="stat-card-blue rounded-xl p-4" data-testid="stat-chunks">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('chunks')}</p>
              <p className="text-3xl font-bold mt-1">{chunks.length}</p>
            </div>
            <Layers className="w-6 h-6 opacity-60" />
          </div>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 min-h-0">
        <div className="flex flex-col min-h-0 bg-card border border-border rounded-xl">
          <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">{t('content')}</h2>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={copyContentMarkdown}
              className="gap-1.5"
              data-testid="copy-content-btn"
            >
              {copied === 'content' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span className="text-xs">{copied === 'content' ? t('copied') : 'Markdown'}</span>
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {elements.length > 0 ? (
              elements.map((el, i) => renderElement(el, i))
            ) : (
              <div className="py-12 text-center">
                <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground text-sm">{t('noDataExtracted')}</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col min-h-0 bg-card border border-border rounded-xl">
          <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">
              RAG {t('chunks')} ({chunks.length})
            </h2>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={copyAllChunks}
              className="gap-1.5"
              data-testid="copy-all-chunks-btn"
            >
              {copied === 'chunks' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span className="text-xs">{copied === 'chunks' ? t('copied') : t('copyAll')}</span>
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {chunks.length > 0 ? (
              <div className="space-y-3">
                {chunks.map((chunk: RagChunk, i: number) => (
                  <div 
                    key={chunk.chunk_id || i} 
                    className={`bg-secondary rounded-lg p-3 border border-border cursor-pointer transition-all hover:bg-secondary/80 ${expandedChunk === i ? 'ring-2 ring-primary' : ''}`}
                    onClick={() => setExpandedChunk(expandedChunk === i ? null : i)}
                    data-testid={`chunk-card-${i}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground">
                          #{i + 1}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => copySingleChunk(chunk, i, e)}
                          data-testid={`copy-chunk-${i}`}
                        >
                          {copiedChunk === i ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </Button>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="text-[10px]">
                          ~{chunk.tokens_estimate} tokens
                        </Badge>
                        {chunk.quality && (
                          <Badge 
                            variant={chunk.quality.quality === 'good' ? 'default' : chunk.quality.quality === 'warning' ? 'secondary' : 'destructive'}
                            className="text-[10px]"
                          >
                            {chunk.quality.quality}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <p className={`text-xs text-foreground mb-2 ${expandedChunk === i ? '' : 'line-clamp-3'}`}>
                      {chunk.text}
                    </p>
                    
                    {chunk.structure?.heading && (
                      <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Tag className="w-3 h-3" />
                        <span className="truncate">{chunk.structure.heading}</span>
                      </div>
                    )}
                    
                    {expandedChunk === i && chunk.ai_metadata?.keywords && chunk.ai_metadata.keywords.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-border">
                        <div className="flex items-center gap-1 mb-2 text-[10px] text-muted-foreground">
                          <Sparkles className="w-3 h-3" />
                          Keywords
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {chunk.ai_metadata.keywords.map((kw: string, ki: number) => (
                            <Badge key={ki} variant="outline" className="text-[10px]">
                              {kw}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {expandedChunk === i && chunk.ai_metadata?.summary && (
                      <div className="mt-3 pt-3 border-t border-border">
                        <div className="flex items-center gap-1 mb-2 text-[10px] text-muted-foreground">
                          <FileText className="w-3 h-3" />
                          {t('summary')}
                        </div>
                        <p className="text-[10px] text-muted-foreground italic">
                          {chunk.ai_metadata.summary}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-12 text-center">
                <Layers className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground text-sm">{t('noChunksYet')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
