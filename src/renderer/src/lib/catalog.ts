import {
  Beer,
  Boxes,
  CodeXml,
  Container,
  Copy,
  Database,
  Download,
  FileArchive,
  FileStack,
  Globe,
  HardDrive,
  Hourglass,
  Languages,
  Mail,
  MonitorCog,
  Rocket,
  ScrollText,
  Smartphone,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { CATEGORIES, type CategoryGroup, type CategoryId } from '../../../core/types';

export type GroupRoute = 'system' | 'development' | 'storage' | 'browsers' | 'large';

export interface GroupInfo {
  group: CategoryGroup;
  route: GroupRoute;
  icon: LucideIcon;
  /** Cor da série nos gráficos. Segue o grupo, nunca a posição. */
  color: string;
}

/** Ordem fixa: é ela que define a ordem das séries e das seções. */
export const GROUPS: GroupInfo[] = [
  { group: 'System Junk', route: 'system', icon: MonitorCog, color: 'var(--series-system)' },
  { group: 'Development', route: 'development', icon: CodeXml, color: 'var(--series-development)' },
  { group: 'Storage', route: 'storage', icon: HardDrive, color: 'var(--series-storage)' },
  { group: 'Browsers', route: 'browsers', icon: Globe, color: 'var(--series-browsers)' },
  { group: 'Large Files', route: 'large', icon: FileStack, color: 'var(--series-large)' },
];

export const GROUP_BY_NAME = Object.fromEntries(GROUPS.map((g) => [g.group, g])) as Record<CategoryGroup, GroupInfo>;

export const CATEGORY_ICONS: Record<CategoryId, LucideIcon> = {
  'system-cache': Database,
  'system-logs': ScrollText,
  'temp-files': Hourglass,
  trash: Trash2,
  downloads: Download,
  'browser-cache': Globe,
  'dev-cache': CodeXml,
  homebrew: Beer,
  docker: Container,
  'ios-backups': Smartphone,
  'mail-attachments': Mail,
  'language-files': Languages,
  'large-files': FileArchive,
  'node-modules': Boxes,
  duplicates: Copy,
  'launch-agents': Rocket,
};

export const ALL_CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[];

export function categoriesOf(group?: CategoryGroup): CategoryId[] {
  const groups = group ? [group] : GROUPS.map((g) => g.group);
  return groups.flatMap((name) => ALL_CATEGORY_IDS.filter((id) => CATEGORIES[id].group === name));
}
