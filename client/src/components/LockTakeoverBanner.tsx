import { AlertTriangle, Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface LockTakeoverBannerProps {
  /** True while the POST /take-lock request is in flight */
  isTakingLock: boolean;
  /** Description text shown in the banner */
  description: string;
  /** Label on the takeover button */
  buttonLabel: string;
  /** Called when the user clicks the "take lock" button */
  onTakeLock: () => void;
}

/**
 * Banner shown in the project detail view when another browser tab currently
 * holds the scrape lock.  Offers a one-click "take over" action.
 */
export default function LockTakeoverBanner({
  isTakingLock,
  description,
  buttonLabel,
  onTakeLock,
}: LockTakeoverBannerProps) {
  return (
    <div className="border border-amber-500/30 bg-amber-500/10 rounded-xl p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
        <p className="text-sm text-foreground">{description}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 gap-2"
        disabled={isTakingLock}
        onClick={onTakeLock}
        data-testid="take-lock-button"
      >
        {isTakingLock ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Play className="w-4 h-4" />
        )}
        {buttonLabel}
      </Button>
    </div>
  );
}
