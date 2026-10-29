import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { app, type BrowserWindow } from 'electron';

/**
 * Ferramenta de desenvolvimento: grava a janela em vídeo enquanto um roteiro
 * mexe nela, para o vídeo de divulgação. A janela é renderizada fora da tela:
 * nada aparece no monitor e a gravação não depende de permissão de captura.
 *
 *   MACLEANFY_RECORD=tomada.mp4 MACLEANFY_RECORD_SCRIPT=cena.mjs pnpm start
 *
 * O roteiro é um módulo com `export default async (r) => { ... }`; `r` move o
 * cursor desenhado, clica, rola e marca os instantes (`r.mark('nome')`), que
 * vão para `tomada.json` ao lado do vídeo, em segundos desde o começo.
 */

const FPS = 30;
const STEP_MS = 1000 / 60;

/**
 * Um seletor, ou o primeiro elemento do seletor que contém `text` (e, dentro dele, o
 * `child`), num ponto relativo `dx`/`dy`; ou um ponto da página.
 */
type Target = string | { sel: string; text?: string; child?: string; dx?: number; dy?: number } | { x: number; y: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A seta do macOS, preta com borda branca, com a ponta no canto de cima. */
const CURSOR = `(() => {
  if (document.getElementById('__rec-cursor')) return;
  const c = document.createElement('div');
  c.id = '__rec-cursor';
  c.innerHTML = '<svg width="26" height="34" viewBox="-1 -1 15 21" style="filter: drop-shadow(0 1.5px 2px rgba(0,0,0,.45))"><path d="M0 0 L0 16.2 L3.9 12.6 L6.6 19 L9.3 17.9 L6.7 11.7 L11.9 11.7 Z" fill="#000" stroke="#fff" stroke-width="1.15" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-60px,-60px)', transformOrigin: '0 0' });
  document.documentElement.appendChild(c);
  window.__recCursor = (x, y, s) => { c.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')'; };
  window.__recRing = (x, y) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: (x - 18) + 'px', top: (y - 18) + 'px', width: '36px', height: '36px', borderRadius: '50%', border: '2px solid rgba(125,246,255,.9)', zIndex: '2147483646', pointerEvents: 'none' });
    document.documentElement.appendChild(r);
    r.animate([{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 420, easing: 'ease-out' }).onfinish = () => r.remove();
  };
})()`;

export class Recorder {
  private latest: Buffer | null = null;
  private size = { width: 0, height: 0 };
  private encoder: ReturnType<typeof spawn> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = 0;
  private written = 0;
  private marks: Array<{ name: string; t: number }> = [];
  private cursor = { x: -60, y: -60 };
  /** O idioma da gravação (`pt` ou `en`), para o roteiro procurar os textos certos. */
  readonly lang: 'pt' | 'en' = (process.env.MACLEANFY_LOCALE ?? '').startsWith('en') ? 'en' : 'pt';

  constructor(
    private readonly win: BrowserWindow,
    private readonly out: string
  ) {
    win.webContents.setFrameRate(60);
    win.webContents.on('paint', (_event, _dirty, image) => {
      const size = image.getSize();
      if (size.width === 0) return;
      this.latest = image.toBitmap();
      this.size = size;
    });
  }

  private js<T = unknown>(code: string): Promise<T> {
    return this.win.webContents.executeJavaScript(code, true) as Promise<T>;
  }

  /** Começa o vídeo: daqui em diante cada 1/30 s vira um quadro, com a última pintura da janela. */
  async start(): Promise<void> {
    await this.js(CURSOR);
    await this.js('document.fonts.ready.then(() => true)');
    while (!this.latest) await sleep(20);
    const { width, height } = this.size;
    // A tela real é 2×; a gravação fica em número par de pixels, como o H.264 pede.
    this.encoder = spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-r', String(FPS), '-i', '-',
        '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'h264_videotoolbox', '-b:v', '45M', '-maxrate', '70M', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1',
        this.out,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] }
    );
    this.started = Date.now();
    this.written = 0;
    this.timer = setInterval(() => this.pump(), 4);
  }

  private pump(): void {
    if (!this.encoder?.stdin || !this.latest) return;
    const due = Math.floor(((Date.now() - this.started) / 1000) * FPS) + 1;
    while (this.written < due) {
      // Um quadro de outro tamanho (a janela piscou) não entra: repete o anterior.
      if (this.latest.length === this.size.width * this.size.height * 4) this.encoder.stdin.write(this.latest);
      this.written++;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.pump();
    const encoder = this.encoder;
    if (encoder?.stdin) {
      const done = new Promise<void>((resolve) => encoder.on('close', () => resolve()));
      encoder.stdin.end();
      await done;
    }
    await writeFile(
      this.out.replace(/\.mp4$/, '.json'),
      JSON.stringify({ fps: FPS, seconds: this.written / FPS, marks: this.marks }, null, 2)
    );
  }

  /** Anota o instante, em segundos desde o começo, para escolher o corte depois. */
  mark(name: string): void {
    this.marks.push({ name, t: Math.round((Date.now() - this.started) / 10) / 100 });
  }

  wait(ms: number): Promise<unknown> {
    return sleep(ms);
  }

  /** O centro de um elemento (ou um ponto dele, com dx/dy de 0 a 1), em pixels da página. */
  async point(target: Target): Promise<{ x: number; y: number }> {
    if (typeof target !== 'string' && 'x' in target) return target;
    const { sel, text, child, dx = 0.5, dy = 0.5 } = typeof target === 'string' ? { sel: target } : target;
    const found = await this.js<{ x: number; y: number } | null>(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(sel)})];
      const text = ${JSON.stringify(text ?? null)};
      const child = ${JSON.stringify(child ?? null)};
      const match = text ? all.find((e) => e.textContent.trim().includes(text)) : all[0];
      const el = match && child ? match.querySelector(child) : match;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width * ${dx}, y: b.top + b.height * ${dy} };
    })()`);
    if (!found) throw new Error(`não achei ${JSON.stringify(target)}`);
    return found;
  }

  async waitFor(selector: string, timeout = 15000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.js<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
      await sleep(50);
    }
    throw new Error(`esperei demais por ${selector}`);
  }

  /** Leva o cursor até o alvo num movimento suave, passando o mouse de verdade (o hover acende). */
  async move(target: Target, ms = 700): Promise<void> {
    const to = await this.point(target);
    const from = { ...this.cursor };
    if (from.x < 0) {
      from.x = to.x + 260;
      from.y = to.y + 180;
    }
    const steps = Math.max(1, Math.round(ms / STEP_MS));
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps);
      const x = Math.round((from.x + (to.x - from.x) * k) * 10) / 10;
      const y = Math.round((from.y + (to.y - from.y) * k) * 10) / 10;
      this.win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
      void this.js(`window.__recCursor(${x}, ${y}, 1)`);
      this.cursor = { x, y };
      await sleep(STEP_MS);
    }
  }

  async click(target: Target, ms = 700): Promise<void> {
    await this.move(target, ms);
    const x = Math.round(this.cursor.x);
    const y = Math.round(this.cursor.y);
    await this.js(`window.__recCursor(${this.cursor.x}, ${this.cursor.y}, 0.88); window.__recRing(${x}, ${y})`);
    this.win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await sleep(90);
    this.win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await this.js(`window.__recCursor(${this.cursor.x}, ${this.cursor.y}, 1)`);
  }

  /** Rola um elemento devagar, com aceleração no começo e freio no fim. */
  async scroll(selector: string, dy: number, ms = 1200): Promise<void> {
    await this.js(`new Promise((resolve) => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return resolve(false);
      const from = el.scrollTop, start = performance.now();
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
      const step = (now) => {
        const k = Math.min(1, (now - start) / ${ms});
        el.scrollTop = from + ${dy} * ease(k);
        k < 1 ? requestAnimationFrame(step) : resolve(true);
      };
      requestAnimationFrame(step);
    })`);
  }

  /** Esconde o cursor (cena sem mouse) ou o põe de volta onde estava. */
  async hideCursor(hidden = true): Promise<void> {
    await this.js(`document.getElementById('__rec-cursor').style.opacity = ${hidden ? 0 : 1}`);
  }

  eval<T = unknown>(code: string): Promise<T> {
    return this.js<T>(code);
  }
}

export function recordWhenReady(win: BrowserWindow, out: string, script: string): void {
  const recorder = new Recorder(win, out);
  win.webContents.once('did-finish-load', async () => {
    try {
      const scene = (await import(/* @vite-ignore */ pathToFileURL(script).href)) as {
        default: (r: Recorder) => Promise<void>;
      };
      await scene.default(recorder);
      await recorder.stop();
    } catch (error) {
      console.error('record failed:', error);
      await recorder.stop().catch(() => undefined);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
}
