import { app, ipcMain, nativeImage, type WebContents } from 'electron';
import type { CategoryId } from '../core/types';
import {
  CHANNELS,
  type CleanSelection,
  type DiskFolderDTO,
  type History,
  type InstalledAppDTO,
  type ItemDTO,
  type PerformanceSample,
  type ProcessGroupDTO,
  type ScanResultDTO,
  type StartupItemDTO,
  type SystemInfo,
} from '../shared/api';
import { getSystemInfo } from './system';

/**
 * Ferramenta de desenvolvimento: `MACLEANFY_DEMO=1` troca o disco, os apps e o
 * Mac de quem roda por dados de demonstração, para gravar o vídeo e fotografar
 * as telas sem mostrar nada de ninguém. Nada é apagado: limpar, desinstalar e
 * mandar para a Lixeira só mexem nestes dados. Nunca vale no app empacotado.
 */

const GB = 1000 ** 3;
const MB = 1000 ** 2;
const KB = 1000;
const GIB = 1024 ** 3;
const HOME = '/Users/ana';
const DAY = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Lang = 'pt' | 'en';
/** Os nomes que a conta de demonstração deu às próprias coisas, nos dois idiomas. */
const L = (pt: string, en: string) => ({ pt, en });

// ---------------------------------------------------------------------------
// Limpeza
// ---------------------------------------------------------------------------

type Fixture = [name: string, path: string, size: number, isDirectory?: boolean];

function items(fixtures: Fixture[]): ItemDTO[] {
  return fixtures.map(([name, path, size, isDirectory = true]) => ({
    name,
    path: path.startsWith('~') ? HOME + path.slice(1) : path,
    size: Math.round(size),
    isDirectory,
    modifiedAt: Date.now() - 40 * DAY,
  }));
}

/** Muitos itens pequenos com nomes parecidos (temporários, traduções, anexos). */
function many(count: number, total: number, make: (i: number) => [string, string]): Fixture[] {
  // Um decaimento suave: os primeiros pesam mais, como numa pasta de verdade.
  const weights = Array.from({ length: count }, (_, i) => 1 / (1 + i * 0.35));
  const sum = weights.reduce((s, w) => s + w, 0);
  return weights.map((w, i) => [...make(i), (w / sum) * total, false] as Fixture);
}

const LANGS = ['de', 'fr', 'it', 'ja', 'ko', 'zh_CN', 'zh_TW', 'ru', 'nl', 'sv', 'da', 'fi', 'nb', 'pl', 'tr', 'cs', 'hu', 'el', 'he', 'ar', 'th', 'uk', 'ro', 'sk', 'hr', 'ca', 'vi', 'id', 'ms', 'hi'];
const LANG_APPS = ['Google Chrome', 'Slack', 'Spotify', 'zoom.us', 'Docker', 'Visual Studio Code', 'Postman', 'GIMP', 'Android Studio', 'Parallels Desktop', 'UTM', 'WhatsApp', 'Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint', 'LM Studio', 'Warp', 'Rider', 'DataGrip', 'Keynote', 'Pages', 'Numbers', 'OneDrive', 'Xnip', 'Rectangle', 'Notepad++', 'DBeaver', 'MongoDB Compass', 'Granola', 'Capsule', 'AltTab', 'Flycut', 'MQTT Explorer', 'Porting Kit', 'QuickDrop', 'Tunnelblick', 'WireGuard', 'LICEcap', 'AnyDesk', 'BambuStudio', 'Dropzone 4'];

function scanFixtures(lang: Lang): Record<CategoryId, ItemDTO[]> {
  const t = (x: { pt: string; en: string }) => x[lang];
  return {
    'system-cache': items([
      ['com.spotify.client', '~/Library/Caches/com.spotify.client', 2.34 * GB],
      ['com.docker.docker', '~/Library/Caches/com.docker.docker', 1.92 * GB],
      ['JetBrains', '~/Library/Caches/JetBrains', 1.61 * GB],
      ['com.tinyspeck.slackmacgap', '~/Library/Caches/com.tinyspeck.slackmacgap', 1.12 * GB],
      ['com.microsoft.VSCode.ShipIt', '~/Library/Caches/com.microsoft.VSCode.ShipIt', 0.81 * GB],
      ['us.zoom.xos', '~/Library/Caches/us.zoom.xos', 0.94 * GB],
      ['com.postmanlabs.mac', '~/Library/Caches/com.postmanlabs.mac', 0.52 * GB],
      ['com.microsoft.Word', '~/Library/Caches/com.microsoft.Word', 0.47 * GB],
      ['org.gimp.gimp-2.10', '~/Library/Caches/org.gimp.gimp-2.10', 0.38 * GB],
      ['com.parallels.desktop.console', '~/Library/Caches/com.parallels.desktop.console', 0.33 * GB],
      ['ai.lmstudio', '~/Library/Caches/ai.lmstudio', 0.29 * GB],
      ...many(35, 0.87 * GB, (i) => [`com.app.cache-${i + 1}`, `~/Library/Caches/com.app.cache-${i + 1}`]),
    ]),
    'system-logs': items([
      ['DiagnosticReports', '~/Library/Logs/DiagnosticReports', 0.42 * GB],
      ['Docker Desktop', '~/Library/Logs/Docker Desktop', 0.31 * GB],
      ['zoom.us', '~/Library/Logs/zoom.us', 0.18 * GB],
      ['JetBrains', '~/Library/Logs/JetBrains', 0.14 * GB],
      ...many(34, 0.25 * GB, (i) => [`log-${i + 1}.log`, `~/Library/Logs/app-${i + 1}.log`]),
    ]),
    'temp-files': items(
      many(127, 2.41 * GB, (i) => [`TemporaryItems-${(i * 7919).toString(36)}`, `/private/var/folders/x1/tmp${(i * 104729).toString(36)}`])
    ),
    trash: items([
      [t(L('Gravação da reunião.mov', 'Meeting recording.mov')), '~/.Trash/Meeting.mov', 2.3 * GB, false],
      ['Xcode_25.xip', '~/.Trash/Xcode_25.xip', 1.9 * GB, false],
      ...many(212, 1.4 * GB, (i) => [`IMG_${4120 + i}.HEIC`, `~/.Trash/IMG_${4120 + i}.HEIC`]),
    ]),
    downloads: items([
      ['Xcode_26.xip', '~/Downloads/Xcode_26.xip', 3.6 * GB, false],
      ['ubuntu-24.04-desktop-arm64.iso', '~/Downloads/ubuntu-24.04-desktop-arm64.iso', 2.9 * GB, false],
      ['Docker.dmg', '~/Downloads/Docker.dmg', 0.62 * GB, false],
      ['android-studio-mac_arm.dmg', '~/Downloads/android-studio-mac_arm.dmg', 1.1 * GB, false],
      ...many(19, 0.68 * GB, (i) => [`arquivo-${i + 1}.zip`, `~/Downloads/arquivo-${i + 1}.zip`]),
    ]),
    'browser-cache': items([
      ['Google Chrome', '~/Library/Caches/Google/Chrome', 2.12 * GB],
      ['Safari', '~/Library/Caches/com.apple.Safari', 0.94 * GB],
      ['Firefox', '~/Library/Caches/Firefox', 0.61 * GB],
      ['Brave', '~/Library/Caches/BraveSoftware', 0.23 * GB],
    ]),
    'dev-cache': items([
      ['Xcode DerivedData', '~/Library/Developer/Xcode/DerivedData', 4.3 * GB],
      ['Gradle', '~/.gradle/caches', 2.1 * GB],
      ['npm', '~/.npm/_cacache', 1.2 * GB],
      ['pnpm', '~/Library/pnpm/store', 0.91 * GB],
      ['CocoaPods', '~/Library/Caches/CocoaPods', 0.62 * GB],
      ['pip', '~/Library/Caches/pip', 0.31 * GB],
      ['Yarn', '~/Library/Caches/Yarn', 0.26 * GB],
    ]),
    homebrew: items(
      many(31, 2.78 * GB, (i) => [`${['node', 'python@3.14', 'openjdk', 'ffmpeg', 'postgresql@17', 'gradle', 'cmake', 'llvm'][i % 8]}--bottle-${i + 1}`, `~/Library/Caches/Homebrew/downloads/bottle-${i + 1}`])
    ),
    docker: items([
      ['Docker Images', 'docker:images', 4.1 * GB, false],
      ['Docker Build Cache', 'docker:build-cache', 2.1 * GB, false],
    ]),
    'ios-backups': items([
      ['iOS Backup: 00008110...', '~/Library/Application Support/MobileSync/Backup/00008110-001A', 21.3 * GB],
    ]),
    'mail-attachments': items(
      many(340, 1.62 * GB, (i) => [`${t(L('anexo', 'attachment'))}-${i + 1}.pdf`, `~/Library/Containers/com.apple.mail/Data/Library/Mail Downloads/${i + 1}.pdf`])
    ),
    'language-files': items(
      many(1240, 1.94 * GB, (i) => {
        const appName = LANG_APPS[i % LANG_APPS.length];
        const code = LANGS[Math.floor(i / LANG_APPS.length) % LANGS.length];
        return [`${code}.lproj`, `/Applications/${appName}.app/Contents/Resources/${code}.lproj`];
      })
    ),
    'large-files': items([
      [t(L('Patagônia 2026 bruto.mov', 'Patagonia 2026 raw.mov')), '~/Movies/Patagonia/raw.mov', 8.4 * GB, false],
      ['Windows 11 ARM.pvm', '~/Parallels/Windows 11 ARM.pvm', 6.2 * GB],
      ['ubuntu-24.04-desktop-arm64.iso', '~/Downloads/ubuntu-24.04-desktop-arm64.iso', 2.9 * GB, false],
      ['qwen3-14b-q4.gguf', '~/.lmstudio/models/qwen3-14b-q4.gguf', 0.9 * GB, false],
    ]),
    'node-modules': items([
      ['loja-online', '~/Projetos/loja-online/node_modules', 2.4 * GB],
      ['app-financas', '~/Projetos/app-financas/node_modules', 1.9 * GB],
      ['api-pagamentos', '~/Projetos/api-pagamentos/node_modules', 1.3 * GB],
      ['site-portfolio', '~/Projetos/site-portfolio/node_modules', 0.92 * GB],
      ['landing-evento', '~/Projetos/landing-evento/node_modules', 0.88 * GB],
    ]),
    duplicates: items(
      many(58, 3.2 * GB, (i) => [`IMG_${2040 + i} (1).jpg`, `~/Pictures/${t(L('Exportadas', 'Exports'))}/IMG_${2040 + i} (1).jpg`])
    ),
    'launch-agents': items([
      ['com.skype.skype.shareagent.plist → Skype.app (missing)', '~/Library/LaunchAgents/com.skype.skype.shareagent.plist', 0.8 * KB, false],
      ['com.evernote.EvernoteHelper.plist → Evernote.app (missing)', '~/Library/LaunchAgents/com.evernote.EvernoteHelper.plist', 0.7 * KB, false],
    ]),
    'app-leftovers': items([
      ['Evernote', '~/Library/Application Support/com.evernote.Evernote', 1.92 * GB],
      ['Skype', '~/Library/Application Support/Skype', 1.24 * GB],
      ['Adobe Premiere Pro', '~/Library/Caches/com.adobe.PremierePro', 0.86 * GB],
      ['Figma', '~/Library/Application Support/Figma', 0.41 * GB],
      ['Notion', '~/Library/Application Support/Notion', 0.18 * GB],
    ]),
  };
}

// ---------------------------------------------------------------------------
// Desinstalador
// ---------------------------------------------------------------------------

interface DemoApp {
  name: string;
  /** Onde o ícone de verdade está, se o app existir neste Mac. */
  bundle: string;
  size: number;
  related: Array<[path: string, size: number, personal?: boolean]>;
  system?: Array<[path: string, size: number]>;
}

const APPS: DemoApp[] = [
  {
    name: 'Android Studio',
    bundle: '/Applications/Android Studio.app',
    size: 3.92 * GB,
    related: [
      ['~/Library/Application Support/Google/AndroidStudio2026.1', 2.1 * GB, true],
      ['~/Library/Caches/Google/AndroidStudio2026.1', 1.6 * GB],
      ['~/Library/Logs/Google/AndroidStudio2026.1', 0.12 * GB],
    ],
  },
  {
    name: 'Docker',
    bundle: '/Applications/Docker.app',
    size: 2.14 * GB,
    related: [
      ['~/Library/Containers/com.docker.docker', 6.8 * GB, true],
      ['~/Library/Caches/com.docker.docker', 1.92 * GB],
      ['~/Library/Group Containers/group.com.docker', 0.21 * GB, true],
      ['~/Library/Preferences/com.docker.docker.plist', 4 * KB, true],
    ],
    system: [
      ['/Library/LaunchDaemons/com.docker.vmnetd.plist', 1.2 * KB],
      ['/Library/PrivilegedHelperTools/com.docker.vmnetd', 2.6 * MB],
    ],
  },
  {
    name: 'Parallels Desktop',
    bundle: '/Applications/Parallels Desktop.app',
    size: 1.21 * GB,
    related: [
      ['~/Library/Caches/com.parallels.desktop.console', 0.33 * GB],
      ['~/Library/Preferences/com.parallels.desktop.console.plist', 12 * KB, true],
    ],
    system: [['/Library/LaunchDaemons/com.parallels.desktop.launchdaemon.plist', 1.1 * KB]],
  },
  {
    name: 'Spotify',
    bundle: '/Applications/Spotify.app',
    size: 0.41 * GB,
    related: [
      ['~/Library/Caches/com.spotify.client', 2.34 * GB],
      ['~/Library/Application Support/Spotify', 0.36 * GB, true],
      ['~/Library/Preferences/com.spotify.client.plist', 6 * KB, true],
      ['~/Library/Saved Application State/com.spotify.client.savedState', 0.2 * MB],
    ],
  },
  {
    name: 'Slack',
    bundle: '/Applications/Slack.app',
    size: 0.52 * GB,
    related: [
      ['~/Library/Containers/com.tinyspeck.slackmacgap', 1.38 * GB, true],
      ['~/Library/Caches/com.tinyspeck.slackmacgap', 1.12 * GB],
    ],
  },
  {
    name: 'zoom.us',
    bundle: '/Applications/zoom.us.app',
    size: 0.31 * GB,
    related: [
      ['~/Library/Application Support/zoom.us', 1.86 * GB, true],
      ['~/Library/Caches/us.zoom.xos', 0.94 * GB],
      ['~/Library/Logs/zoom.us', 0.18 * GB],
      ['~/Library/Preferences/us.zoom.xos.plist', 8 * KB, true],
      ['~/Library/HTTPStorages/us.zoom.xos', 1.4 * MB],
      ['~/Library/Saved Application State/us.zoom.xos.savedState', 0.1 * MB],
    ],
    system: [
      ['/Library/LaunchDaemons/us.zoom.ZoomDaemon.plist', 1.3 * KB],
      ['/Library/PrivilegedHelperTools/us.zoom.ZoomDaemon', 3.8 * MB],
    ],
  },
  {
    name: 'Google Chrome',
    bundle: '/Applications/Google Chrome.app',
    size: 1.34 * GB,
    related: [
      ['~/Library/Application Support/Google/Chrome', 1.9 * GB, true],
      ['~/Library/Caches/Google/Chrome', 2.12 * GB],
    ],
    system: [['/Library/LaunchAgents/com.google.keystone.agent.plist', 0.9 * KB]],
  },
  {
    name: 'Visual Studio Code',
    bundle: '/Applications/Visual Studio Code.app',
    size: 0.64 * GB,
    related: [
      ['~/Library/Application Support/Code', 0.88 * GB, true],
      ['~/Library/Caches/com.microsoft.VSCode.ShipIt', 0.81 * GB],
    ],
  },
  {
    name: 'Postman',
    bundle: '/Applications/Postman.app',
    size: 0.48 * GB,
    related: [
      ['~/Library/Application Support/Postman', 0.31 * GB, true],
      ['~/Library/Caches/com.postmanlabs.mac', 0.52 * GB],
    ],
  },
  {
    name: 'GIMP',
    bundle: '/Applications/GIMP.app',
    size: 0.92 * GB,
    related: [
      ['~/Library/Application Support/GIMP', 42 * MB, true],
      ['~/Library/Caches/org.gimp.gimp-2.10', 0.38 * GB],
    ],
  },
  {
    name: 'UTM',
    bundle: '/Applications/UTM.app',
    size: 0.35 * GB,
    related: [['~/Library/Containers/com.utmapp.UTM', 0.12 * GB, true]],
  },
  {
    name: 'WhatsApp',
    bundle: '/Applications/WhatsApp.app',
    size: 0.28 * GB,
    related: [['~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared', 0.94 * GB, true]],
  },
  {
    name: 'Warp',
    bundle: '/Applications/Warp.app',
    size: 0.21 * GB,
    related: [['~/Library/Application Support/dev.warp.Warp-Stable', 64 * MB, true]],
  },
  {
    name: 'LM Studio',
    bundle: '/Applications/LM Studio.app',
    size: 0.58 * GB,
    related: [
      ['~/Library/Application Support/LM Studio', 0.22 * GB, true],
      ['~/Library/Caches/ai.lmstudio', 0.29 * GB],
    ],
  },
];

const APP_ICON_SIZE = { width: 76, height: 76 };

async function appsFixture(removed: Set<string>): Promise<InstalledAppDTO[]> {
  const list = APPS.filter((info) => !removed.has(info.bundle));
  const apps = await Promise.all(
    list.map(async (info) => {
      const related = info.related.map(([path, size, personal = false]) => ({
        path: path.replace(/^~/, HOME),
        size: Math.round(size),
        personal,
      }));
      const system = (info.system ?? []).map(([path, size]) => ({ path, size: Math.round(size) }));
      const icon = await nativeImage
        .createThumbnailFromPath(info.bundle, APP_ICON_SIZE)
        .then((image) => image.toDataURL())
        .catch(() => undefined);
      return {
        name: info.name,
        path: info.bundle,
        size: Math.round(info.size),
        related,
        system,
        totalSize: Math.round(info.size + [...related, ...system].reduce((sum, entry) => sum + entry.size, 0)),
        icon,
      };
    })
  );
  // Do maior para o menor, como a listagem de verdade.
  return apps.sort((a, b) => b.totalSize - a.totalSize);
}

// ---------------------------------------------------------------------------
// Espaço em disco
// ---------------------------------------------------------------------------

interface Node {
  name: string;
  size: number;
  children?: Node[];
}

const dir = (name: string, children: Node[]): Node => ({
  name,
  size: children.reduce((sum, child) => sum + child.size, 0),
  children,
});
const file = (name: string, size: number): Node => ({ name, size: Math.round(size) });

function diskTree(lang: Lang): Node {
  const t = (x: { pt: string; en: string }) => x[lang];
  return dir('ana', [
    dir('Library', [
      file('Application Support', 24.1 * GB),
      file('Containers', 13.8 * GB),
      file('Caches', 11.8 * GB),
      file('Developer', 7.9 * GB),
      file('Group Containers', 2.2 * GB),
      file('Mobile Documents', 1.6 * GB),
    ]),
    dir('Movies', [
      dir(t(L('Patagônia 2026 (4K)', 'Patagonia 2026 (4K)')), [
        file('A001_C014.mov', 8.4 * GB),
        file('A001_C009.mov', 6.1 * GB),
        file('A002_C003.mov', 5.3 * GB),
        file('A002_C011.mov', 4.6 * GB),
        file('drone_0412.mp4', 3.9 * GB),
        file('timelapse_glaciar.mov', 2.9 * GB),
      ]),
      file(t(L('Casamento Bia e Léo.fcpbundle', 'Bia and Leo Wedding.fcpbundle')), 12.4 * GB),
      file(t(L('Aulas gravadas', 'Recorded classes')), 3.1 * GB),
      file('Screen Recordings', 1.6 * GB),
    ]),
    dir(t(L('Projetos', 'Projects')), [
      file('loja-online', 9.3 * GB),
      file('app-financas', 7.8 * GB),
      file('api-pagamentos', 5.1 * GB),
      file('site-portfolio', 2.2 * GB),
      file('landing-evento', 1.9 * GB),
    ]),
    dir('Downloads', [
      file('Xcode_26.xip', 9.8 * GB),
      file('ubuntu-24.04-desktop-arm64.iso', 2.9 * GB),
      file('android-studio-mac_arm.dmg', 1.1 * GB),
      file('Docker.dmg', 0.62 * GB),
      file(t(L('Fotos da viagem.zip', 'Trip photos.zip')), 2.4 * GB),
      file(t(L('Apresentação final.key', 'Final presentation.key')), 0.38 * GB),
    ]),
    dir('Pictures', [file('Photos Library.photoslibrary', 16.9 * GB), file(t(L('Exportadas', 'Exports')), 1.3 * GB)]),
    file('Documents', 9.4 * GB),
    file('Parallels', 6.2 * GB),
    file('Music', 6.1 * GB),
    file('.docker', 4.2 * GB),
    file('.gradle', 2.9 * GB),
    file('Desktop', 2.3 * GB),
    file('.npm', 1.8 * GB),
  ]);
}

// ---------------------------------------------------------------------------
// Desempenho
// ---------------------------------------------------------------------------

function wave(seed: number, tick: number, base: number, swing: number): number {
  return base + Math.sin(tick * 0.9 + seed) * swing + Math.sin(tick * 2.3 + seed * 3) * swing * 0.4;
}

function processGroup(name: string, cpu: number, memory: number, count: number, system = false): ProcessGroupDTO {
  return { name, cpu: Math.max(0, Math.round(cpu * 10) / 10), memory: Math.round(memory), count, system };
}

function performanceSample(tick: number): PerformanceSample {
  const cores = Array.from({ length: 12 }, (_, i) => Math.min(1, Math.max(0.03, wave(i, tick, i < 4 ? 0.72 : 0.34, 0.18))));
  const usage = cores.reduce((sum, v) => sum + v, 0) / cores.length;
  const total = 18 * GIB;
  const used = wave(1, tick, 15.3, 0.25) * GIB;
  const topCpu = [
    processGroup('Docker', wave(2, tick, 96, 6), 2.6 * GIB, 7),
    processGroup('Google Chrome', wave(3, tick, 63, 14), 4.8 * GIB, 31),
    processGroup('Xcode', wave(4, tick, 38, 9), 3.1 * GIB, 5),
    processGroup('WindowServer', wave(5, tick, 21, 4), 0.52 * GIB, 1, true),
    processGroup('Slack', wave(6, tick, 9, 3), 1.1 * GIB, 6),
    processGroup('Spotify', wave(7, tick, 6, 2), 0.64 * GIB, 4),
  ].sort((a, b) => b.cpu - a.cpu);
  const topMemory = [...topCpu].sort((a, b) => b.memory - a.memory);
  return {
    at: Date.now(),
    cpu: { usage, cores, load: [7.8, 7.1, 6.4] },
    memory: { total, used, cached: 2.1 * GIB, pressure: 'warning', swapUsed: 3.4 * GIB, swapTotal: 4 * GIB },
    disk: { read: wave(8, tick, 38, 20) * MB, write: wave(9, tick, 12, 8) * MB },
    network: { iface: 'en0', down: wave(10, tick, 4.2, 2.6) * MB, up: wave(11, tick, 0.6, 0.4) * MB },
    battery: { percent: 84, charging: false, plugged: false, cycles: 212, health: 0.91, temperature: 33.4 },
    uptime: 23 * 86400 + 4 * 3600,
    thermal: 'nominal',
    topCpu,
    topMemory,
    findings: [
      { id: 'memory', severity: 'warning', apps: ['Google Chrome', 'Xcode', 'Docker'] },
      { id: 'runaway', severity: 'warning', app: 'Docker', hours: 9, average: 94 },
      { id: 'uptime', severity: 'warning', days: 23 },
    ],
  };
}

const STARTUP: StartupItemDTO[] = [
  { label: 'com.docker.vmnetd', app: 'Docker', scope: 'daemon', when: 'load', running: true },
  { label: 'com.nordvpn.macos.helper', app: 'NordVPN', scope: 'daemon', when: 'load', running: true },
  { label: 'com.spotify.webhelper', app: 'Spotify', scope: 'user', when: 'load', running: true },
  { label: 'com.skype.skype.shareagent', app: null, scope: 'user', when: 'load', missing: true },
  { label: 'com.google.keystone.agent', app: 'Google Chrome', scope: 'agent', when: 'schedule' },
  { label: 'com.parallels.desktop.launchdaemon', app: 'Parallels Desktop', scope: 'daemon', when: 'load', running: true },
  { label: 'com.evernote.EvernoteHelper', app: null, scope: 'user', when: 'load', missing: true },
  { label: 'com.microsoft.update.agent', app: 'Microsoft AutoUpdate', scope: 'agent', when: 'schedule' },
  { label: 'org.postgresql.postgres', app: null, scope: 'daemon', when: 'load', running: true },
  { label: 'com.adobe.ARMDC.Communicator', app: null, scope: 'daemon', when: 'demand', disabled: true },
].map((item) => {
  const folder =
    item.scope === 'user' ? `${HOME}/Library/LaunchAgents` : item.scope === 'agent' ? '/Library/LaunchAgents' : '/Library/LaunchDaemons';
  return {
    label: item.label,
    path: `${folder}/${item.label}.plist`,
    scope: item.scope as StartupItemDTO['scope'],
    app: item.app,
    program: null,
    when: item.when as StartupItemDTO['when'],
    missing: item.missing ?? false,
    disabled: item.disabled ?? false,
    running: item.running ?? false,
  };
});

// ---------------------------------------------------------------------------
// Os canais
// ---------------------------------------------------------------------------

export function registerDemoIpc(): void {
  const lang: Lang = (process.env.MACLEANFY_LOCALE ?? '').startsWith('en') ? 'en' : 'pt';
  const fixtures = scanFixtures(lang);
  const cleaned = new Set<CategoryId>();
  const removedApps = new Set<string>();
  const tree = diskTree(lang);
  let measured = false;
  let tick = 0;

  // Um Mac de 512 GB quase cheio.
  const disk = { volumeName: 'Macintosh HD', total: 494.38 * GB, free: 38.2 * GB };
  const now = Date.now();
  const history: History = {
    since: now - 104 * DAY,
    totalFreedSpace: 23.6 * GB,
    totalItems: 1873,
    entries: [
      { at: now - 6 * DAY, kind: 'clean', freedSpace: 4.2 * GB, items: 312, labels: ['browser-cache', 'trash'] },
      { at: now - 15 * DAY, kind: 'uninstall', freedSpace: 2.9 * GB, items: 1, labels: ['Microsoft Teams'] },
      { at: now - 27 * DAY, kind: 'clean', freedSpace: 16.5 * GB, items: 1560, labels: ['system-cache', 'dev-cache', 'node-modules'] },
    ],
  };
  const maintenance = { noDsStore: false, snapshots: ['2026-10-25-093011', '2026-10-26-101544', '2026-10-27-084902'] };

  const handle = (channel: string, listener: (sender: WebContents, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => listener(event.sender, ...args));
  const send = (sender: WebContents, channel: string, payload: unknown) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  handle(CHANNELS.systemInfo, async (): Promise<SystemInfo> => {
    const real = await getSystemInfo();
    return {
      ...real,
      appVersion: app.getVersion(),
      modelName: 'MacBook Pro',
      chip: 'Apple M3 Pro',
      memory: '18 GB',
      disk: { ...disk, total: Math.round(disk.total), free: Math.round(disk.free) },
      fullDiskAccess: true,
    };
  });
  handle(CHANNELS.historyGet, () => history);
  handle(CHANNELS.updateState, () => ({ status: 'unsupported' }));
  for (const channel of [CHANNELS.updateCheck, CHANNELS.updateDownload, CHANNELS.updateInstall]) handle(channel, () => undefined);

  const resultOf = (id: CategoryId): ScanResultDTO => {
    const list = cleaned.has(id) ? [] : fixtures[id];
    return { categoryId: id, items: list, totalSize: list.reduce((sum, item) => sum + item.size, 0) };
  };

  handle(CHANNELS.scanRun, async (sender, categoryIds) => {
    const ids = (Array.isArray(categoryIds) ? categoryIds : Object.keys(fixtures)) as CategoryId[];
    const results: ScanResultDTO[] = [];
    // As respostas chegam fora de ordem, como as de verdade: as pastas pequenas primeiro.
    const order = [...ids].sort((a, b) => resultOf(a).items.length - resultOf(b).items.length || a.localeCompare(b));
    for (const [index, id] of order.entries()) {
      await sleep(ids.length > 4 ? 140 + ((index * 53) % 170) : 260);
      const result = resultOf(id);
      results.push(result);
      send(sender, CHANNELS.scanProgress, { completed: index + 1, total: ids.length, result });
    }
    return results;
  });

  handle(CHANNELS.cleanRun, async (sender, selection, options) => {
    const valid = (Array.isArray(selection) ? selection : []) as CleanSelection[];
    const dryRun = (options as { dryRun?: boolean } | undefined)?.dryRun === true;
    const plan = valid.map((entry) => {
      const chosen = new Set(entry.paths);
      const list = fixtures[entry.categoryId].filter((item) => chosen.has(item.path));
      return { id: entry.categoryId, count: list.length, size: list.reduce((sum, item) => sum + item.size, 0) };
    });
    const totalBytes = plan.reduce((sum, entry) => sum + entry.size, 0);
    const steps = 40;
    let doneBytes = 0;
    for (const [index, entry] of plan.entries()) {
      const slices = Math.max(4, Math.round((steps * entry.size) / Math.max(totalBytes, 1)));
      for (let s = 0; s < slices; s++) {
        await sleep(55);
        doneBytes += entry.size / slices;
        send(sender, CHANNELS.cleanProgress, {
          completed: index,
          total: plan.length,
          categoryId: entry.id,
          doneBytes: Math.min(doneBytes, totalBytes),
          totalBytes,
        });
      }
    }
    const totalCleanedItems = plan.reduce((sum, entry) => sum + entry.count, 0);
    if (!dryRun) {
      for (const entry of plan) cleaned.add(entry.id);
      disk.free += totalBytes;
      history.totalFreedSpace += totalBytes;
      history.totalItems += totalCleanedItems;
      history.entries.unshift({
        at: Date.now(),
        kind: 'clean',
        freedSpace: totalBytes,
        items: totalCleanedItems,
        labels: plan.map((entry) => entry.id),
      });
    }
    return {
      results: plan.map((entry) => ({ categoryId: entry.id, cleanedItems: entry.count, freedSpace: entry.size, errors: [] })),
      totalFreedSpace: totalBytes,
      totalCleanedItems,
      totalErrors: 0,
      dryRun,
    };
  });

  handle(CHANNELS.appsList, async (sender) => {
    const total = 214;
    for (let done = 0; done <= total; done += 18) {
      send(sender, CHANNELS.appsProgress, { completed: Math.min(done, total), total });
      await sleep(70);
    }
    return appsFixture(removedApps);
  });

  handle(CHANNELS.appsUninstall, async (_sender, appPaths, options) => {
    const keepPersonal = (options as { keepPersonal?: boolean } | undefined)?.keepPersonal === true;
    const chosen = APPS.filter((info) => (appPaths as string[]).includes(info.bundle) && !removedApps.has(info.bundle));
    await sleep(1600);
    let freed = 0;
    let system = 0;
    for (const info of chosen) {
      removedApps.add(info.bundle);
      freed += info.size + info.related.filter(([, , personal]) => !(keepPersonal && personal)).reduce((sum, [, size]) => sum + size, 0);
      for (const [, size] of info.system ?? []) {
        freed += size;
        system++;
      }
    }
    // O app vai para a Lixeira: o espaço livre só muda quando ela é esvaziada.
    history.totalFreedSpace += freed;
    history.entries.unshift({ at: Date.now(), kind: 'uninstall', freedSpace: freed, items: chosen.length, labels: chosen.map((info) => info.name) });
    return {
      uninstalled: chosen.length,
      freedSpace: Math.round(freed),
      errors: [],
      ...(system > 0 ? { system: { removed: system, kept: 0 } } : {}),
    };
  });

  handle(CHANNELS.performanceSample, () => performanceSample(tick++));
  handle(CHANNELS.startupList, async () => {
    await sleep(300);
    return STARTUP;
  });

  /** O nó de um caminho da conta de demonstração, e o rastro até ele. */
  const find = (path?: string): { node: Node; crumbs: Array<{ name: string; path: string }> } | null => {
    const parts = (path ?? HOME).replace(HOME, '').split('/').filter(Boolean);
    let node = tree;
    const crumbs = [{ name: tree.name, path: HOME }];
    for (const part of parts) {
      const next = node.children?.find((child) => child.name === part);
      if (!next) return null;
      node = next;
      crumbs.push({ name: part, path: `${crumbs[crumbs.length - 1].path}/${part}` });
    }
    return { node, crumbs };
  };
  const folderOf = (path?: string): DiskFolderDTO | null => {
    const found = find(path);
    if (!found) return null;
    const here = found.crumbs[found.crumbs.length - 1].path;
    return {
      path: here,
      crumbs: found.crumbs,
      size: found.node.size,
      entries: [...(found.node.children ?? [])]
        .sort((a, b) => b.size - a.size)
        .map((child) => ({ name: child.name, path: `${here}/${child.name}`, size: child.size, directory: !!child.children || !/\.[a-z0-9]{2,5}$/i.test(child.name) })),
      scannedAt: Date.now() - 4000,
      home: tree.size,
      disk: { total: Math.round(disk.total), free: Math.round(disk.free) },
    };
  };

  handle(CHANNELS.diskList, async (sender, path, options) => {
    const { cachedOnly, refresh } = (options ?? {}) as { cachedOnly?: boolean; refresh?: boolean };
    if (!measured || refresh) {
      if (cachedOnly) return null;
      const order = [...(tree.children ?? [])].reverse();
      let bytes = 0;
      for (const child of order) {
        for (let i = 0; i < 3; i++) {
          bytes += child.size / 3;
          send(sender, CHANNELS.diskProgress, { bytes, path: `${HOME}/${child.name}/${['…', 'Data', 'Cache'][i]}` });
          await sleep(60);
        }
      }
      measured = true;
    } else await sleep(40);
    return folderOf(typeof path === 'string' ? path : undefined);
  });

  handle(CHANNELS.diskTrash, async (_sender, path) => {
    if (typeof path !== 'string') return false;
    const parent = find(path.slice(0, path.lastIndexOf('/')));
    const name = path.slice(path.lastIndexOf('/') + 1);
    const index = parent?.node.children?.findIndex((child) => child.name === name) ?? -1;
    if (!parent || index < 0) return false;
    await sleep(500);
    const [gone] = parent.node.children!.splice(index, 1);
    // Os tamanhos de cima descontam o que saiu, até a pasta pessoal.
    let node: Node = tree;
    tree.size -= gone.size;
    for (const crumb of parent.crumbs.slice(1)) {
      node = node.children!.find((child) => child.name === crumb.name)!;
      node.size -= gone.size;
    }
    // Na Lixeira o arquivo ainda ocupa o disco: o espaço livre fica como está.
    return true;
  });

  handle(CHANNELS.maintenanceInfo, async () => {
    await sleep(200);
    return { purgeable: Math.round(18.6 * GB), snapshots: maintenance.snapshots, spotlight: true, noDsStore: maintenance.noDsStore };
  });
  handle(CHANNELS.maintenanceRun, async (_sender, task) => {
    await sleep(task === 'spotlight' ? 2200 : 1500);
    if (task === 'snapshots') maintenance.snapshots = [];
    return { success: true };
  });
  handle(CHANNELS.maintenanceNoDsStore, async (_sender, on) => {
    await sleep(300);
    maintenance.noDsStore = on === true;
    return { success: true };
  });

  // Nada sai do app: Finder, Ajustes, navegador e área de transferência ficam quietos.
  for (const channel of [
    CHANNELS.reveal,
    CHANNELS.openExternal,
    CHANNELS.openFullDiskAccess,
    CHANNELS.openLoginItems,
    CHANNELS.openActivityMonitor,
    CHANNELS.copyPixCode,
  ]) {
    handle(channel, () => undefined);
  }
}
