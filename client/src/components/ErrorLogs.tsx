import { AlertTriangle, Clock, Terminal } from 'lucide-react';
import type { ScrapingError } from '@shared/schema';

interface ErrorLogsProps {
  errors: ScrapingError[];
  t: (key: any) => string;
}

export default function ErrorLogs({ errors, t }: ErrorLogsProps) {
  if (errors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Terminal className="h-12 w-12 mb-4 opacity-20" />
        <p className="text-lg font-medium">{t('allSystemsNormal')}</p>
        <p className="text-sm">{t('errorsLoggedHere')}</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      {errors.map((error, idx) => (
        <div 
          key={idx} 
          className="bg-card border-l-4 border-destructive rounded-lg shadow-sm p-4 flex gap-4"
          data-testid={`error-log-${idx}`}
        >
          <div className="p-2 bg-destructive/10 rounded-full h-fit">
            <AlertTriangle className="h-5 w-5 text-destructive" />
          </div>
          <div className="flex-1 space-y-1 min-w-0">
            <div className="flex items-center justify-between gap-4">
              <h4 className="text-sm font-bold text-foreground truncate" title={error.url}>
                {error.url}
              </h4>
              <span className="text-[10px] font-medium text-muted-foreground flex items-center gap-1 shrink-0">
                <Clock className="h-3 w-3" /> {new Date(error.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-xs text-destructive font-medium">{error.message}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
