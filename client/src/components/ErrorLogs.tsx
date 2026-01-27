import { AlertTriangle, Clock, CheckCircle2 } from 'lucide-react';
import type { ScrapingError } from '@shared/schema';

interface ErrorLogsProps {
  errors: ScrapingError[];
  t: (key: any) => string;
}

export default function ErrorLogs({ errors, t }: ErrorLogsProps) {
  if (errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-500/20 flex items-center justify-center mb-4">
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        </div>
        <p className="text-foreground font-medium">{t('allSystemsNormal')}</p>
        <p className="text-sm text-muted-foreground mt-1">{t('errorsLoggedHere')}</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-2">
      {errors.map((error, idx) => (
        <div 
          key={idx} 
          className="bg-card border-l-2 border-destructive rounded-lg p-4 flex gap-3"
          data-testid={`error-log-${idx}`}
        >
          <div className="p-2 bg-destructive/20 rounded-lg h-fit shrink-0">
            <AlertTriangle className="w-4 h-4 text-destructive" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm font-medium text-foreground truncate" title={error.url}>
                {error.url}
              </p>
              <span className="text-[10px] text-muted-foreground flex items-center gap-1 shrink-0">
                <Clock className="w-3 h-3" />
                {new Date(error.timestamp).toLocaleTimeString('de-DE')}
              </span>
            </div>
            <p className="text-xs text-destructive mt-1">{error.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
