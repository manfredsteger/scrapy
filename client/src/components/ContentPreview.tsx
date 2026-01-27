import { X, Image as ImageIcon, Video, FileCode } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { SitemapUrlEntry, ScrapedElement } from '@shared/schema';

interface ContentPreviewProps {
  entry: SitemapUrlEntry;
  onClose: () => void;
  t: (key: any) => string;
}

function renderElement(el: ScrapedElement, idx: number) {
  if (el.type === 'heading') {
    const sizes: Record<string, string> = {
      h1: 'text-3xl font-black mt-8 mb-4',
      h2: 'text-2xl font-bold mt-6 mb-3',
      h3: 'text-xl font-semibold mt-5 mb-2',
      h4: 'text-lg font-semibold mt-4 mb-2',
      h5: 'text-base font-medium mt-3 mb-1',
      h6: 'text-sm font-medium mt-2 mb-1',
    };
    const sizeClass = sizes[el.tag || 'h2'] || sizes.h2;
    
    return (
      <div key={idx} className="group relative">
        <span className="absolute -left-12 top-1 text-[9px] font-bold text-muted-foreground/50 uppercase opacity-0 group-hover:opacity-100 transition-opacity">
          {el.tag}
        </span>
        <div className={`${sizeClass} text-foreground leading-tight`}>
          {el.content}
        </div>
      </div>
    );
  }
  
  if (el.type === 'paragraph') {
    return (
      <div key={idx} className="group relative">
        <span className="absolute -left-12 top-1 text-[9px] font-bold text-muted-foreground/50 uppercase opacity-0 group-hover:opacity-100 transition-opacity">
          P
        </span>
        <p className="text-base text-muted-foreground leading-relaxed mb-4 whitespace-pre-wrap">
          {el.content}
        </p>
      </div>
    );
  }
  
  if (el.type === 'list') {
    const Tag = el.tag === 'ol' ? 'ol' : 'ul';
    const listStyle = el.tag === 'ol' ? 'list-decimal' : 'list-disc';
    
    return (
      <div key={idx} className="group relative">
        <span className="absolute -left-12 top-1 text-[9px] font-bold text-muted-foreground/50 uppercase opacity-0 group-hover:opacity-100 transition-opacity">
          {el.tag}
        </span>
        <Tag className={`${listStyle} pl-6 mb-4 space-y-1 text-muted-foreground`}>
          {(el.children as string[] || []).map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </Tag>
      </div>
    );
  }
  
  if (el.type === 'blockquote') {
    return (
      <blockquote key={idx} className="border-l-4 border-primary/30 pl-4 py-2 mb-4 italic text-muted-foreground bg-muted/30 rounded-r-md">
        {el.content}
      </blockquote>
    );
  }
  
  if (el.type === 'code') {
    return (
      <pre key={idx} className="bg-muted p-4 rounded-xl mb-4 overflow-x-auto text-sm font-mono text-foreground">
        <code>{el.content}</code>
      </pre>
    );
  }
  
  if (el.type === 'table' && el.children) {
    const rows = el.children as string[][];
    return (
      <div key={idx} className="overflow-x-auto mb-4">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? 'bg-muted font-medium' : 'border-t border-border'}>
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
      <div key={idx} className="my-6 bg-muted/50 rounded-2xl p-6 border border-dashed border-border text-center">
        <div className="flex items-center justify-center gap-4 mb-4">
          {el.tag === 'img' ? (
            <ImageIcon className="h-8 w-8 text-primary/60" />
          ) : (
            <Video className="h-8 w-8 text-amber-500" />
          )}
          <div className="text-left">
            <p className="text-[10px] font-bold text-muted-foreground uppercase">
              {el.tag === 'img' ? 'Image' : 'Video'}
            </p>
            <a 
              href={el.src} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs font-medium text-primary truncate block max-w-sm hover:underline"
            >
              {el.src}
            </a>
          </div>
        </div>
        {el.alt && (
          <p className="text-sm text-muted-foreground">Alt: "{el.alt}"</p>
        )}
      </div>
    );
  }
  
  return null;
}

export default function ContentPreview({ entry, onClose, t }: ContentPreviewProps) {
  const data = entry.scrapedData;
  
  return (
    <div className="fixed inset-0 z-[100] bg-background/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-card rounded-3xl w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col shadow-2xl border border-border">
        <div className="px-8 py-6 border-b border-border flex items-center justify-between bg-card shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <span className="bg-primary/10 text-primary text-[10px] font-bold px-2 py-1 rounded uppercase tracking-widest">
                {t('deepScrape')}
              </span>
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">
                {data?.timestamp}
              </span>
            </div>
            <h3 className="text-xl font-bold text-foreground truncate tracking-tight">
              {data?.title}
            </h3>
            <p className="text-xs text-muted-foreground truncate mt-1">{entry.loc}</p>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={onClose}
            className="shrink-0"
            data-testid="close-preview"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        
        <ScrollArea className="flex-1">
          <div className="p-8 bg-muted/30">
            <div className="max-w-3xl mx-auto space-y-6 bg-card p-8 rounded-2xl shadow-sm border border-border">
              <div className="border-b border-border pb-6 mb-6 flex justify-between items-center">
                <div className="text-center flex-1 border-r border-border">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase mb-1">
                    {t('totalWords')}
                  </p>
                  <p className="text-xl font-bold text-primary">
                    {data?.wordCount.toLocaleString()}
                  </p>
                </div>
                <div className="text-center flex-1 border-r border-border">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase mb-1">
                    {t('domNodes')}
                  </p>
                  <p className="text-xl font-bold text-primary">
                    {data?.orderedElements.length}
                  </p>
                </div>
                <div className="text-center flex-1">
                  <p className="text-[10px] font-bold text-muted-foreground uppercase mb-1">
                    {t('mediaAssets')}
                  </p>
                  <p className="text-xl font-bold text-primary">
                    {data?.orderedElements.filter(e => e.type === 'media').length}
                  </p>
                </div>
              </div>

              <div className="pl-12 relative">
                {data?.orderedElements.map((el, i) => renderElement(el, i))}
                
                {(!data?.orderedElements || data.orderedElements.length === 0) && (
                  <div className="py-20 text-center">
                    <FileCode className="h-16 w-16 text-muted-foreground/20 mx-auto mb-4" />
                    <p className="text-muted-foreground font-medium uppercase tracking-widest text-xs">
                      {t('noDataExtracted')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
