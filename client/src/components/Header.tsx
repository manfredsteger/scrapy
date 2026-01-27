import { Network, Globe, Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type Language } from '@/lib/i18n';

interface HeaderProps {
  onLogoClick?: () => void;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  t: (key: any) => string;
}

export default function Header({ onLogoClick, language, onLanguageChange, t }: HeaderProps) {
  return (
    <header className="bg-card border-b border-border sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
        <div 
          className="flex items-center gap-3 cursor-pointer group select-none"
          onClick={onLogoClick}
          data-testid="logo-button"
        >
          <div className="bg-primary p-2 rounded-lg shadow-md group-hover:opacity-90 transition-opacity">
            <Network className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground tracking-tight leading-none group-hover:text-primary transition-colors">
              {t('appTitle')}
            </h1>
            <span className="text-[10px] font-bold text-primary uppercase tracking-widest">
              {t('appSubtitle')}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-2" data-testid="language-toggle">
                <Languages className="h-4 w-4" />
                <span className="uppercase font-bold text-xs">{language}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => onLanguageChange('de')}
                className={language === 'de' ? 'bg-accent' : ''}
                data-testid="language-de"
              >
                <Globe className="h-4 w-4 mr-2" />
                {t('german')}
              </DropdownMenuItem>
              <DropdownMenuItem 
                onClick={() => onLanguageChange('en')}
                className={language === 'en' ? 'bg-accent' : ''}
                data-testid="language-en"
              >
                <Globe className="h-4 w-4 mr-2" />
                {t('english')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
