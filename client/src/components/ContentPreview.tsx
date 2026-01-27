import { X, Image as ImageIcon, Video, FileText, Hash } from 'lucide-react';
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

export default function ContentPreview({ entry, onClose, t }: ContentPreviewProps) {
  const data = entry.scrapedData;
  
  return (
    <div className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card rounded-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col border border-border shadow-2xl">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-foreground truncate">
              {data?.title}
            </h3>
            <p className="text-xs text-muted-foreground truncate mt-0.5">{entry.loc}</p>
          </div>
          <Button 
            variant="ghost" 
            size="icon"
            onClick={onClose}
            className="shrink-0 ml-4"
            data-testid="close-preview"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>
        
        <div className="grid grid-cols-3 gap-4 p-4 border-b border-border shrink-0">
          <div className="bg-secondary rounded-lg p-3 text-center">
            <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{t('totalWords')}</p>
            <p className="text-lg font-bold text-foreground">{data?.wordCount.toLocaleString()}</p>
          </div>
          <div className="bg-secondary rounded-lg p-3 text-center">
            <Hash className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{t('domNodes')}</p>
            <p className="text-lg font-bold text-foreground">{data?.orderedElements.length}</p>
          </div>
          <div className="bg-secondary rounded-lg p-3 text-center">
            <ImageIcon className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">{t('mediaAssets')}</p>
            <p className="text-lg font-bold text-foreground">
              {data?.orderedElements.filter(e => e.type === 'media').length}
            </p>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6">
            {data?.orderedElements.map((el, i) => renderElement(el, i))}
            
            {(!data?.orderedElements || data.orderedElements.length === 0) && (
              <div className="py-12 text-center">
                <p className="text-muted-foreground">{t('noDataExtracted')}</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
