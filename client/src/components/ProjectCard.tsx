import { useState } from 'react';
import { Globe, Trash2, ChevronRight, Pencil, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Project } from '@shared/schema';

interface ProjectWithCounts extends Project {
  _resultsCount?: number;
  _scrapedCount?: number;
  _chunksCount?: number;
}

interface ProjectCardProps {
  project: ProjectWithCounts;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void;
  t: (key: any) => string;
}

export default function ProjectCard({ project, onSelect, onDelete, onRename, t }: ProjectCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(project.displayName || project.domain);

  const handleRename = () => {
    if (editValue.trim()) {
      onRename(editValue.trim());
    }
    setIsEditing(false);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(project.displayName || project.domain);
    setIsEditing(true);
  };

  const isActive = project.status !== 'idle';
  // Use API-provided counts when available, fallback to calculating from results
  const urlCount = project._resultsCount ?? project.results?.length ?? 0;
  const scrapedCount = project._scrapedCount ?? project.results?.filter(r => r.scrapedData).length ?? 0;

  return (
    <div
      className="bg-card border border-border rounded-xl p-5 cursor-pointer hover:border-primary/50 transition-all group"
      onClick={() => !isEditing && onSelect()}
      data-testid={`project-card-${project.id}`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`p-2.5 rounded-lg shrink-0 ${isActive ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
            {isActive ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Globe className="w-5 h-5" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <Input 
                  autoFocus
                  className="h-8 text-sm font-medium bg-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename();
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                  data-testid="edit-project-input"
                />
                <Button size="icon" variant="ghost" className="h-8 w-8 text-emerald-400" onClick={handleRename}>
                  <Check className="w-4 h-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setIsEditing(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold text-foreground truncate">
                    {project.displayName || project.domain}
                  </h4>
                  <Button 
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={handleEditClick}
                    data-testid="edit-project-button"
                  >
                    <Pencil className="w-3 h-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {project.lastScraped ? new Date(project.lastScraped).toLocaleDateString('de-DE') : '-'}
                </p>
              </>
            )}
          </div>
        </div>
        <Button 
          size="icon"
          variant="ghost"
          className="shrink-0 h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={handleDelete}
          data-testid="delete-project"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-secondary rounded-lg p-3 text-center">
          <p className="text-[10px] font-medium text-muted-foreground uppercase">{t('urls')}</p>
          <p className="text-lg font-bold text-foreground">{urlCount}</p>
        </div>
        <div className="bg-secondary rounded-lg p-3 text-center">
          <p className="text-[10px] font-medium text-muted-foreground uppercase">Scraped</p>
          <p className="text-lg font-bold text-foreground">{scrapedCount}</p>
        </div>
        <div className="bg-secondary rounded-lg p-3 text-center">
          <p className="text-[10px] font-medium text-muted-foreground uppercase">{t('status')}</p>
          <p className={`text-xs font-bold uppercase ${isActive ? 'text-primary' : 'text-emerald-400'}`}>
            {isActive ? 'Active' : 'Idle'}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm text-primary font-medium pt-3 border-t border-border">
        <span>{t('detailedView')}</span>
        <ChevronRight className="w-4 h-4" />
      </div>
    </div>
  );
}
