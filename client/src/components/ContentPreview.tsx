import { useState } from 'react';
import { X, Image as ImageIcon, Video, FileText, Hash, Copy, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SitemapUrlEntry, ScrapedElement } from '@shared/schema';

interface ContentPreviewProps {
  entry: SitemapUrlEntry;
  onClose: () => void;
  t: (key: any) => string;
}

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
    } catch {
      // Fallback
    }
  }
  
  // Fallback for HTTP contexts or when clipboard API fails
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

function elementToHtml(el: ScrapedElement): string {
  if (el.type === 'heading') {
    const tag = el.tag || 'h2';
    return `<${tag}>${el.content}</${tag}>\n`;
  }
  if (el.type === 'paragraph') {
    return `<p>${el.content}</p>\n`;
  }
  if (el.type === 'list') {
    const items = (el.children as string[] || []);
    const tag = el.tag === 'ol' ? 'ol' : 'ul';
    return `<${tag}>\n${items.map(item => `  <li>${item}</li>`).join('\n')}\n</${tag}>\n`;
  }
  if (el.type === 'blockquote') {
    return `<blockquote>${el.content}</blockquote>\n`;
  }
  if (el.type === 'code') {
    return `<pre><code>${el.content}</code></pre>\n`;
  }
  if (el.type === 'media') {
    return el.tag === 'img' 
      ? `<img src="${el.src}" alt="${el.alt || ''}" />\n`
      : `<video src="${el.src}"></video>\n`;
  }
  if (el.type === 'table') {
    const headers = (el as any).headers as string[] || [];
    const rows = (el as any).rows as string[][] || el.children as string[][] || [];
    let html = '<table>\n';
    if (headers.length > 0) {
      html += '  <thead>\n    <tr>\n';
      headers.forEach(h => { html += `      <th>${h}</th>\n`; });
      html += '    </tr>\n  </thead>\n';
    }
    html += '  <tbody>\n';
    rows.forEach(row => {
      if (Array.isArray(row)) {
        html += '    <tr>\n';
        row.forEach(cell => { html += `      <td>${cell}</td>\n`; });
        html += '    </tr>\n';
      }
    });
    html += '  </tbody>\n</table>\n';
    return html;
  }
  return '';
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
  const [copied, setCopied] = useState<string | null>(null);
  const data = entry.scrapedData;
  
  const copyContent = async (format: 'markdown' | 'json' | 'html') => {
    if (!data) return;
    
    let content = '';
    
    if (format === 'markdown') {
      content = `# ${data.title}\n\n`;
      content += data.orderedElements.map(elementToMarkdown).join('');
    } else if (format === 'json') {
      content = JSON.stringify({
        url: entry.loc,
        title: data.title,
        wordCount: data.wordCount,
        elements: data.orderedElements,
      }, null, 2);
    } else if (format === 'html') {
      content = `<!DOCTYPE html>\n<html>\n<head>\n  <title>${data.title}</title>\n</head>\n<body>\n`;
      content += `<h1>${data.title}</h1>\n`;
      content += data.orderedElements.map(elementToHtml).join('');
      content += '</body>\n</html>';
    }
    
    const success = await copyToClipboard(content);
    if (success) {
      setCopied(format);
      setTimeout(() => setCopied(null), 2000);
    }
  };
  
  return (
    <div 
      className="fixed inset-0 z-50 bg-background/90 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-card rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-border shadow-2xl">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="min-w-0 flex-1 mr-4">
            <h3 className="text-lg font-semibold text-foreground truncate">
              {data?.title}
            </h3>
            <p className="text-xs text-muted-foreground truncate mt-0.5">{entry.loc}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2" data-testid="copy-dropdown">
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  {copied ? t('copied') : t('copyAs')}
                  <ChevronDown className="w-3 h-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => copyContent('markdown')} data-testid="copy-markdown">
                  <FileText className="w-4 h-4 mr-2" />
                  {t('copyMarkdown')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => copyContent('json')} data-testid="copy-json">
                  <FileText className="w-4 h-4 mr-2" />
                  {t('copyJson')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => copyContent('html')} data-testid="copy-html">
                  <FileText className="w-4 h-4 mr-2" />
                  {t('copyHtml')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button 
              variant="ghost" 
              size="icon"
              onClick={onClose}
              data-testid="close-preview"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>
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

        <div className="flex-1 overflow-y-auto p-6">
          {data?.orderedElements.map((el, i) => renderElement(el, i))}
          
          {(!data?.orderedElements || data.orderedElements.length === 0) && (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">{t('noDataExtracted')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
