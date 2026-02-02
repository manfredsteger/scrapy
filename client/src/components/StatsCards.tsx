import { FileText, Image as ImageIcon, Video, Clock, Activity, ListOrdered, Globe, CheckCircle, XCircle } from 'lucide-react';
import type { ScrapingStats } from '@shared/schema';

interface StatsCardsProps {
  stats: ScrapingStats | null;
  urlCount?: number;
  scrapedCount?: number;
  failedCount?: number;
  t: (key: any) => string;
}

export default function StatsCards({ stats, urlCount = 0, scrapedCount = 0, failedCount = 0, t }: StatsCardsProps) {
  const duration = stats?.endTime 
    ? (stats.endTime - stats.startTime) / 1000 
    : stats?.startTime 
      ? (Date.now() - stats.startTime) / 1000
      : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card-green rounded-xl p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('urlsFound')}</p>
              <p className="text-3xl font-bold mt-1">{urlCount.toLocaleString()}</p>
            </div>
            <Globe className="w-6 h-6 opacity-60" />
          </div>
        </div>
        
        <div className="stat-card-purple rounded-xl p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('images')}</p>
              <p className="text-3xl font-bold mt-1">{(stats?.totalImages || 0).toLocaleString()}</p>
            </div>
            <ImageIcon className="w-6 h-6 opacity-60" />
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
        
        {failedCount > 0 ? (
          <div className="rounded-xl p-4 bg-red-500/10 border border-red-500/30">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium text-red-400 uppercase tracking-wide">Failed</p>
                <p className="text-3xl font-bold text-red-400 mt-1">{failedCount}</p>
              </div>
              <XCircle className="w-6 h-6 text-red-400/60" />
            </div>
          </div>
        ) : (
          <div className="stat-card-blue rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-medium opacity-80 uppercase tracking-wide">{t('sitemaps')}</p>
                <p className="text-3xl font-bold mt-1">{stats?.processedSitemaps || 0}</p>
              </div>
              <FileText className="w-6 h-6 opacity-60" />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card-neutral rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('videos')}</p>
              <p className="text-2xl font-bold text-foreground mt-1">{stats?.totalVideos || 0}</p>
            </div>
            <Video className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>
        
        <div className="stat-card-neutral rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('timeElapsed')}</p>
              <p className="text-2xl font-bold text-foreground mt-1">{duration.toFixed(1)}s</p>
            </div>
            <Clock className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>
        
        <div className="stat-card-neutral rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t('rate')}</p>
              <p className="text-2xl font-bold text-foreground mt-1">{(urlCount / (duration || 1)).toFixed(1)}/s</p>
            </div>
            <Activity className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>
        
        <div className="stat-card-neutral rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Sitemaps</p>
              <p className="text-2xl font-bold text-foreground mt-1">{stats?.totalSitemaps || 0}</p>
            </div>
            <ListOrdered className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>
      </div>
    </div>
  );
}
