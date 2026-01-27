import { FileText, Image as ImageIcon, Video, Clock, Activity, ListOrdered } from 'lucide-react';
import { Card } from '@/components/ui/card';
import type { ScrapingStats } from '@shared/schema';

interface StatsCardsProps {
  stats: ScrapingStats | null;
  t: (key: any) => string;
}

export default function StatsCards({ stats, t }: StatsCardsProps) {
  if (!stats) return null;
  
  const duration = stats.endTime 
    ? (stats.endTime - stats.startTime) / 1000 
    : (Date.now() - stats.startTime) / 1000;
  
  const cards = [
    { label: t('sitemaps'), value: `${stats.processedSitemaps} / ${stats.totalSitemaps}`, icon: FileText, color: 'text-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
    { label: t('urlsFound'), value: stats.totalUrls.toLocaleString(), icon: ListOrdered, color: 'text-primary', bg: 'bg-primary/10' },
    { label: t('images'), value: stats.totalImages.toLocaleString(), icon: ImageIcon, color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-950/30' },
    { label: t('videos'), value: stats.totalVideos.toLocaleString(), icon: Video, color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-950/30' },
    { label: t('timeElapsed'), value: `${duration.toFixed(1)}s`, icon: Clock, color: 'text-muted-foreground', bg: 'bg-muted' },
    { label: t('rate'), value: `${(stats.totalUrls / (duration || 1)).toFixed(1)}/s`, icon: Activity, color: 'text-rose-500', bg: 'bg-rose-50 dark:bg-rose-950/30' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
      {cards.map((card, idx) => (
        <Card key={idx} className="p-4 hover-elevate transition-transform" data-testid={`stat-card-${idx}`}>
          <div className="flex flex-col items-center text-center space-y-2">
            <div className={`${card.bg} ${card.color} p-2.5 rounded-xl`}>
              <card.icon className="h-5 w-5" />
            </div>
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{card.label}</p>
              <p className="text-lg font-bold text-foreground tracking-tight">{card.value}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
