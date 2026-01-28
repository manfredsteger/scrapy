import { useState } from 'react';
import { 
  LayoutDashboard, Globe, Settings, FileText, 
  ChevronLeft, ChevronRight, Network, Download, Upload
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SidebarProps {
  activeView: 'dashboard' | 'project';
  onNavigate: (view: 'dashboard' | 'project') => void;
  onImport: () => void;
  t: (key: any) => string;
}

export default function Sidebar({ activeView, onNavigate, onImport, t }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const menuItems = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  ];

  return (
    <aside 
      className={`h-screen bg-[hsl(var(--sidebar-background))] border-r border-border flex flex-col transition-all duration-300 ${
        collapsed ? 'w-16' : 'w-56'
      }`}
    >
      <div className="h-14 flex items-center justify-between px-3 border-b border-border">
        {!collapsed ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
              <Network className="w-4 h-4 text-primary-foreground" />
            </div>
            <div className="leading-none min-w-0">
              <span className="text-sm font-bold text-foreground">MapScraper</span>
              <span className="text-[10px] text-muted-foreground block">Pro Edition</span>
            </div>
          </div>
        ) : (
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center mx-auto">
            <Network className="w-4 h-4 text-primary-foreground" />
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCollapsed(!collapsed)}
          className="shrink-0"
          data-testid="toggle-sidebar"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </Button>
      </div>

      <nav className="flex-1 p-2 space-y-1">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id as any)}
            className={`sidebar-item w-full ${activeView === item.id ? 'sidebar-item-active' : ''}`}
            data-testid={`nav-${item.id}`}
          >
            <item.icon className="w-5 h-5 shrink-0" />
            {!collapsed && <span>{item.label}</span>}
          </button>
        ))}
        
        <button
          onClick={onImport}
          className="sidebar-item w-full"
          data-testid="nav-import"
        >
          <Upload className="w-5 h-5 shrink-0" />
          {!collapsed && <span>{t('import')}</span>}
        </button>
      </nav>

    </aside>
  );
}
