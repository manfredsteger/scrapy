import { Globe, CheckCircle, XCircle, Hourglass, Paperclip } from 'lucide-react';

interface StatsCardsProps {
  urlCount?: number;
  scrapedCount?: number;
  failedCount?: number;
  pendingCount?: number;
  attachmentCount?: number;
  t: (key: any) => string;
}

export default function StatsCards({ urlCount = 0, scrapedCount = 0, failedCount = 0, pendingCount = 0, attachmentCount = 0, t }: StatsCardsProps) {

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="stat-card-green rounded-xl p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('urlsFound')}</p>
              <p className="text-3xl font-bold mt-1" data-testid="text-urls-found">{urlCount.toLocaleString()}</p>
            </div>
            <Globe className="w-6 h-6 opacity-60" />
          </div>
        </div>

        <div className={`rounded-xl p-4 ${attachmentCount > 0 ? 'bg-violet-500/10 border border-violet-500/30' : 'stat-card-neutral'}`}>
          <div className="flex items-start justify-between">
            <div>
              <p className={`text-xs font-medium uppercase tracking-wide ${attachmentCount > 0 ? 'text-violet-400' : 'text-muted-foreground'}`}>{t('attachments')}</p>
              <p className={`text-3xl font-bold mt-1 ${attachmentCount > 0 ? 'text-violet-400' : 'text-foreground'}`} data-testid="text-attachment-count">{attachmentCount.toLocaleString()}</p>
            </div>
            <Paperclip className={`w-6 h-6 ${attachmentCount > 0 ? 'text-violet-400/60' : 'text-muted-foreground'}`} />
          </div>
        </div>
        
        <div className="rounded-xl p-4 bg-amber-500/10 border border-amber-500/30">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-amber-400 uppercase tracking-wide">Pending</p>
              <p className="text-3xl font-bold text-amber-400 mt-1">{pendingCount}</p>
            </div>
            <Hourglass className="w-6 h-6 text-amber-400/60" />
          </div>
        </div>
        
        <div className="stat-card-orange rounded-xl p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">Scraped</p>
              <p className="text-3xl font-bold mt-1">{scrapedCount}</p>
            </div>
            <CheckCircle className="w-6 h-6 opacity-60" />
          </div>
        </div>
        
        <div className={`rounded-xl p-4 ${failedCount > 0 ? 'bg-red-500/10 border border-red-500/30' : 'stat-card-neutral'}`}>
          <div className="flex items-start justify-between">
            <div>
              <p className={`text-xs font-medium uppercase tracking-wide ${failedCount > 0 ? 'text-red-400' : 'text-muted-foreground'}`}>Failed</p>
              <p className={`text-3xl font-bold mt-1 ${failedCount > 0 ? 'text-red-400' : 'text-foreground'}`}>{failedCount}</p>
            </div>
            <XCircle className={`w-6 h-6 ${failedCount > 0 ? 'text-red-400/60' : 'text-muted-foreground'}`} />
          </div>
        </div>
      </div>
    </div>
  );
}
