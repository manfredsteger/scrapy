import { useState } from 'react';
import { Globe, Trash2, ChevronRight, Pencil, Check, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Project } from '@shared/schema';

interface ProjectCardProps {
  project: Project;
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

  return (
    <Card
      className="p-6 cursor-pointer hover:border-primary hover:shadow-lg transition-all group relative"
      onClick={() => !isEditing && onSelect()}
      data-testid={`project-card-${project.id}`}
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`p-3 rounded-xl shrink-0 ${project.status !== 'idle' ? 'bg-primary text-primary-foreground animate-pulse' : 'bg-muted text-muted-foreground'}`}>
            <Globe className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0 pr-2">
            {isEditing ? (
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <Input 
                  autoFocus
                  className="h-8 text-sm font-bold"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename();
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                  data-testid="edit-project-input"
                />
                <Button 
                  size="icon" 
                  variant="ghost" 
                  className="h-8 w-8 text-emerald-500 hover:text-emerald-600"
                  onClick={handleRename}
                  data-testid="save-project-name"
                >
                  <Check className="h-4 w-4" />
                </Button>
                <Button 
                  size="icon" 
                  variant="ghost" 
                  className="h-8 w-8"
                  onClick={() => setIsEditing(false)}
                  data-testid="cancel-edit"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex flex-col min-w-0">
                <div className="flex items-center gap-2 group/title min-w-0">
                  <h4 className="font-bold text-foreground truncate text-base group-hover:text-primary transition-colors leading-tight">
                    {project.displayName || project.domain}
                  </h4>
                  <Button 
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={handleEditClick}
                    data-testid="edit-project-button"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground font-medium uppercase mt-1 tracking-wider">
                  {t('activity')}: {project.lastScraped ? new Date(project.lastScraped).toLocaleDateString() : '-'}
                </p>
              </div>
            )}
          </div>
        </div>
        <Button 
          size="icon"
          variant="ghost"
          className="shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={handleDelete}
          data-testid="delete-project"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4 text-center">
        <div className="bg-muted rounded-xl p-3">
          <p className="text-[10px] font-medium text-muted-foreground uppercase mb-0.5">{t('urls')}</p>
          <p className="text-lg font-bold text-foreground">{project.stats?.totalUrls?.toLocaleString() || 0}</p>
        </div>
        <div className="bg-muted rounded-xl p-3">
          <p className="text-[10px] font-medium text-muted-foreground uppercase mb-0.5">{t('status')}</p>
          <p className={`text-[11px] font-bold uppercase tracking-widest ${project.status !== 'idle' ? 'text-primary' : 'text-emerald-600'}`}>
            {t(project.status as any) || project.status}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-border text-sm font-bold text-primary">
        <span className="flex items-center gap-1">
          {t('detailedView')} <ChevronRight className="h-4 w-4" />
        </span>
      </div>
    </Card>
  );
}
