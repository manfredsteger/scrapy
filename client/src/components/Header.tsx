import { Globe, Languages, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { type Language } from '@/lib/i18n';

interface HeaderProps {
  title?: string;
  subtitle?: string;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  t: (key: any) => string;
}

export default function Header({ title, subtitle, language, onLanguageChange, t }: HeaderProps) {
  return (
    <header className="h-14 border-b border-border bg-card flex items-center justify-between px-6">
      <div>
        {title && <h1 className="text-lg font-semibold text-foreground">{title}</h1>}
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-medium">
          <Circle className="w-2 h-2 fill-current" />
          System aktiv
        </div>
        
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" data-testid="language-toggle">
              <Languages className="w-4 h-4" />
              <span className="uppercase text-xs font-medium">{language}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem 
              onClick={() => onLanguageChange('de')}
              className={language === 'de' ? 'bg-accent' : ''}
              data-testid="language-de"
            >
              <Globe className="w-4 h-4 mr-2" />
              {t('german')}
            </DropdownMenuItem>
            <DropdownMenuItem 
              onClick={() => onLanguageChange('en')}
              className={language === 'en' ? 'bg-accent' : ''}
              data-testid="language-en"
            >
              <Globe className="w-4 h-4 mr-2" />
              {t('english')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
