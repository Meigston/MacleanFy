import { Activity, ChartPie, Gauge, HeartHandshake, Info, PackageX, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import { useT } from '../i18n';
import { GROUPS } from '../lib/catalog';
import { useStore, type Route } from '../state/store';

interface Entry {
  route: Route;
  icon: LucideIcon;
  label: string;
}

export function Sidebar() {
  const tr = useT();
  const route = useStore((state) => state.route);
  const navigate = useStore((state) => state.navigate);
  // Quem fechou o aviso de versão nova continua vendo, no ícone do Sobre, que ela existe.
  const hasUpdate = useStore((state) => state.update.status === 'available' || state.update.status === 'ready');

  const sections: Entry[][] = [
    [
      { route: 'overview', icon: Gauge, label: tr.t('nav.overview') },
      { route: 'performance', icon: Activity, label: tr.t('nav.performance') },
      { route: 'smart', icon: Sparkles, label: tr.t('nav.smart') },
    ],
    GROUPS.map((group) => ({ route: group.route, icon: group.icon, label: tr.group(group.group) })),
    [
      { route: 'disk', icon: ChartPie, label: tr.t('nav.disk') },
      { route: 'uninstaller', icon: PackageX, label: tr.t('nav.uninstaller') },
      { route: 'maintenance', icon: Wrench, label: tr.t('nav.maintenance') },
    ],
  ];

  const item = ({ route: target, icon: Icon, label }: Entry) => (
    <button
      key={target}
      type="button"
      className={`sidebar__item${route === target ? ' sidebar__item--active' : ''}${
        target === 'about' && hasUpdate ? ' sidebar__item--badge' : ''
      }`}
      aria-label={label}
      aria-current={route === target ? 'page' : undefined}
      data-tip={label}
      data-route={target}
      onClick={() => navigate(target)}
    >
      <Icon size={20} strokeWidth={1.7} />
    </button>
  );

  return (
    <nav className="sidebar">
      {sections.map((entries, index) => (
        <div className="sidebar__section" key={index}>
          {index > 0 && <span className="sidebar__divider" />}
          {entries.map(item)}
        </div>
      ))}
      <span className="sidebar__spacer" />
      {item({ route: 'support', icon: HeartHandshake, label: tr.t('nav.support') })}
      {item({ route: 'about', icon: Info, label: tr.t('nav.about') })}
    </nav>
  );
}
