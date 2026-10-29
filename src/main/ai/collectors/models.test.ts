import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, lutimes, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AiScanner } from '../scanner';
import { DAY, NOW, fakeContext, put, sandbox, type FakeOptions } from '../testing';
import type { AiContext, Collector, Found, ProcessInfo } from '../types';
import { modelCollectors, ollamaCollector, ollamaName } from './models';

describe('model collectors', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.cleanup();
  });

  const ctxFor = (extra: Partial<FakeOptions> = {}) => fakeContext({ ...box, ...extra });
  const byId = (id: string): Collector => modelCollectors.find((c) => c.id === id)!;
  const run = async (id: string, ctx: AiContext = ctxFor()) => clean(await byId(id).collect(ctx));
  const find = (items: Found[], label: string) => items.find((i) => i.label === label)!;
  const labels = (items: Found[]) => items.map((i) => i.label).sort();
  const json = (path: string, value: unknown, daysAgo = 0) => put(path, JSON.stringify(value), daysAgo);
  const proc = (exe: string, args = exe): ProcessInfo => ({ pid: 4242, exe, args });

  /** Caminho absoluto, sem barra no fim, e nunca item vazio. */
  function clean(items: Found[]): Found[] {
    for (const item of items) {
      for (const path of item.paths ?? [item.path]) {
        expect(path.startsWith('/')).toBe(true);
        expect(path.endsWith('/')).toBe(false);
      }
      expect(item.size).toBeGreaterThan(0);
    }
    return items;
  }

  it('has one collector per local model tool', () => {
    expect(modelCollectors.map((c) => c.id)).toEqual([
      'lm-studio',
      'ollama',
      'hugging-face',
      'jan',
      'gpt4all',
      'chrome-ai',
      'rembg',
      'torch',
      'whisper',
    ]);
  });

  describe('LM Studio', () => {
    const lms = () => join(box.home, '.lmstudio');

    async function library() {
      const models = join(lms(), 'models');
      await put(join(models, 'lmstudio-community/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf'), 4000, 120);
      await put(join(models, 'lmstudio-community/Qwen3.5-9B-GGUF/mmproj-Qwen3.5-9B.gguf'), 1000, 120);
      await put(join(models, 'lmstudio-community/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q4_K_M.gguf'), 3000, 180);
      await put(join(models, 'mlx-community/Qwen3-TTS/model.safetensors'), 2000, 2);
      await put(join(models, 'acme/Direct-Model/weights.gguf'), 1500, 60);
      await json(join(lms(), 'settings.json'), { downloadsFolder: models, hfDownloadToken: 'hf_secret' });
      await json(join(lms(), 'hub/models/qwen/qwen3.5-9b/manifest.json'), {
        type: 'model',
        dependencies: [
          {
            modelKeys: ['lmstudio-community/qwen3.5-9b-gguf'],
            sources: [{ type: 'huggingface', user: 'lmstudio-community', repo: 'Qwen3.5-9B-GGUF' }],
          },
        ],
      });
      // superjson, como o app grava: um Map serializado como lista de pares.
      await json(join(lms(), '.internal/model-data.json'), {
        json: [
          ['qwen/qwen3.5-9b', { source: { type: 'hub', owner: 'qwen', name: 'qwen3.5-9b' }, lastLoadedTimestamp: NOW - 30 * DAY }],
          [
            'lmstudio-community/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf',
            { source: { type: 'huggingface', owner: 'lmstudio-community', repo: 'Qwen3.5-9B-GGUF' }, transitive: true },
          ],
          ['qwen/qwen3.6-27b', { source: { type: 'hub', owner: 'qwen', name: 'qwen3.6-27b' } }],
          ['acme/Direct-Model', { source: { type: 'huggingface', owner: 'acme', repo: 'Direct-Model' }, lastLoadedTimestamp: NOW - 3 * DAY }],
        ],
        meta: { values: ['map'] },
      });
      await put(join(lms(), '.internal/utils/node'), 5000, 200);
      await put(join(lms(), 'conversations/1780354157865.conversation.json'), 3000, 200);
    }

    it('lists each model folder with the last load the app recorded', async () => {
      await library();
      const ctx = ctxFor();
      const items = await run('lm-studio', ctx);

      expect(labels(items)).toEqual([
        'acme/Direct-Model',
        'lmstudio-community/Qwen3.5-9B-GGUF',
        'lmstudio-community/Qwen3.6-27B-GGUF',
        'mlx-community/Qwen3-TTS',
      ]);
      const loadedViaHub = find(items, 'lmstudio-community/Qwen3.5-9B-GGUF');
      expect(loadedViaHub).toMatchObject({ lastUsed: NOW - 30 * DAY, confidence: 'high', size: 5000, count: 2 });
      expect(find(items, 'acme/Direct-Model')).toMatchObject({ lastUsed: NOW - 3 * DAY, confidence: 'high' });
      expect(ctx.isCold(find(items, 'acme/Direct-Model').lastUsed)).toBe(false);

      // Nunca carregados: vale a data do download, com confiança baixa.
      const neverLoaded = find(items, 'lmstudio-community/Qwen3.6-27B-GGUF');
      expect(neverLoaded).toMatchObject({ lastUsed: NOW - 180 * DAY, confidence: 'low', hint: 'never-loaded' });
      expect(ctx.isCold(neverLoaded.lastUsed)).toBe(true);
      const justDownloaded = find(items, 'mlx-community/Qwen3-TTS');
      expect(justDownloaded).toMatchObject({ lastUsed: NOW - 2 * DAY, confidence: 'low' });
      expect(ctx.isCold(justDownloaded.lastUsed)).toBe(false);

      for (const item of items) {
        expect(item).toMatchObject({ kind: 'model', safety: 'moderate', removal: 'trash' });
        expect(['redownload', 'never-loaded']).toContain(item.hint);
        expect(item.blocked).toBeUndefined();
      }
      expect(items.some((i) => /\.internal|settings\.json|conversations|hub\//.test(i.path))).toBe(false);
    });

    it('follows downloadsFolder and the home pointer, and also reads the legacy folder', async () => {
      const root = join(box.home, 'Moved/lmstudio');
      await writeFile(join(box.home, '.lmstudio-home-pointer'), root);
      await json(join(root, 'settings.json'), { downloadsFolder: join(box.home, 'AI/models') });
      await put(join(box.home, 'AI/models/bartowski/Llama-3-GGUF/llama.gguf'), 1000, 10);
      await put(join(root, 'models/ignored/Not-Here/x.gguf'), 1000, 10);
      await put(join(box.home, '.cache/lm-studio/models/TheBloke/Old-GGUF/old.gguf'), 800, 400);

      const items = await run('lm-studio');
      expect(labels(items)).toEqual(['TheBloke/Old-GGUF', 'bartowski/Llama-3-GGUF']);
      expect(find(items, 'bartowski/Llama-3-GGUF').path).toBe(join(box.home, 'AI/models/bartowski/Llama-3-GGUF'));
    });

    it('offers runtimes the app no longer selects, and the vendor Python only they use', async () => {
      const backends = join(lms(), 'extensions/backends');
      const frameworks = join(lms(), 'extensions/frameworks');
      const runtime = async (dir: string, name: string, version: string, vendor?: string[]) => {
        await json(join(dir, `${name}-${version}`, 'backend-manifest.json'), {
          name,
          version,
          ...(vendor ? { vendor_lib_package_names: vendor } : {}),
        });
        await put(join(dir, `${name}-${version}`, 'libengine.dylib'), 600, 100);
      };
      const llama = 'llama.cpp-mac-arm64-apple-metal-advsimd';
      const mlx = 'mlx-llm-mac-arm64-apple-metal-advsimd';
      await runtime(backends, llama, '2.22.0');
      await runtime(backends, llama, '2.7.1');
      await runtime(backends, mlx, '1.9.1', ['_amphibian/app-mlx-generate-mac14-arm64@31', '_amphibian/cpython3.11-mac-arm64@10']);
      await runtime(backends, mlx, '1.3.0', ['_amphibian/app-mlx-generate-mac14-arm64@19', '_amphibian/cpython3.11-mac-arm64@10']);
      // A versão escolhida deste não está instalada: nada dele sai.
      await runtime(backends, 'other-mac-arm64', '1.0.0');
      await runtime(frameworks, 'harmony-mac-arm64-apple-metal-advsimd', '0.3.5', ['_amphibian/app-harmony-mac-arm64@6']);
      await runtime(frameworks, 'lmlink-connector-mac-arm64-apple-metal-advsimd', '0.0.5');
      await runtime(frameworks, 'lmlink-connector-mac-arm64-apple-metal-advsimd', '0.1.0');
      for (const pkg of ['app-mlx-generate-mac14-arm64@19', 'app-mlx-generate-mac14-arm64@31', 'cpython3.11-mac-arm64@10', 'app-harmony-mac-arm64@6']) {
        await put(join(backends, 'vendor/_amphibian', pkg, 'lib/python.dylib'), 900, 100);
      }
      await json(join(lms(), '.internal/backend-preferences-v1.json'), [
        { model_format: 'gguf', name: llama, version: '2.22.0' },
        { model_format: 'safetensors', name: mlx, version: '1.9.1' },
        { model_format: 'other', name: 'other-mac-arm64', version: '9.9.9' },
      ]);

      const items = await run('lm-studio');
      expect(labels(items)).toEqual(['app-mlx-generate-mac14-arm64@19', 'llama.cpp 2.7.1', 'lmlink-connector 0.0.5', 'mlx-llm 1.3.0']);
      for (const item of items) {
        expect(item).toMatchObject({ kind: 'runtime', junk: 'old-version', safety: 'safe', removal: 'trash', confidence: 'low' });
      }
      expect(find(items, 'app-mlx-generate-mac14-arm64@19').path).toBe(join(backends, 'vendor/_amphibian/app-mlx-generate-mac14-arm64@19'));
    });

    it('blocks everything while LM Studio is open and checks again before removing', async () => {
      await library();
      const app = proc('/Applications/LM Studio.app/Contents/MacOS/LM Studio');
      const items = await run('lm-studio', ctxFor({ processes: [app] }));
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.blocked === 'app-open')).toBe(true);

      const [first] = await run('lm-studio');
      expect(first.blocked).toBeUndefined();
      expect(await first.recheck!(ctxFor({ processes: [app] }))).toBe('app-open');
      expect(await first.recheck!(ctxFor())).toBeNull();
    });
  });

  describe('Ollama', () => {
    const hex = (c: string) => c.repeat(64);
    const models = () => join(box.home, '.ollama/models');

    async function pull(root: string, parts: string[], blobs: Record<string, number>, daysAgo: number) {
      const [config, ...layers] = Object.keys(blobs);
      await json(
        join(root, 'manifests', ...parts),
        { schemaVersion: 2, config: { digest: `sha256:${config}` }, layers: layers.map((d) => ({ digest: `sha256:${d}` })) },
        daysAgo
      );
      for (const [digest, size] of Object.entries(blobs)) await put(join(root, 'blobs', `sha256-${digest}`), size, daysAgo);
    }

    async function library(root = models()) {
      await pull(root, ['registry.ollama.ai/library/llama3/latest'], { [hex('a')]: 10, [hex('b')]: 5000, [hex('c')]: 100 }, 40);
      await pull(root, ['registry.ollama.ai/library/llama3/8b'], { [hex('a')]: 10, [hex('b')]: 5000, [hex('c')]: 100 }, 40);
      await pull(root, ['registry.ollama.ai/library/mistral/7b'], { [hex('d')]: 20, [hex('e')]: 3000, [hex('c')]: 100 }, 60);
    }

    async function binary() {
      const path = join(box.root, 'bin/ollama');
      await put(path, '#!/bin/sh\n');
      await chmod(path, 0o755);
      return path;
    }

    it('names tags like ollama ls does', () => {
      expect(ollamaName(['registry.ollama.ai', 'library', 'llama3', 'latest'])).toBe('llama3:latest');
      expect(ollamaName(['registry.ollama.ai', 'someone', 'tiny', 'q4'])).toBe('someone/tiny:q4');
      expect(ollamaName(['hf.co', 'org', 'repo-GGUF', 'Q4_K_M'])).toBe('hf.co/org/repo-GGUF:Q4_K_M');
    });

    it('lists one item per model, counting only the layers no other model uses', async () => {
      await library();
      await put(join(box.home, '.ollama/id_ed25519'), 400);
      await put(join(box.home, '.ollama/history'), 400);
      await put(
        join(box.home, '.ollama/logs/server.log'),
        `time=${new Date(NOW - 2 * DAY).toISOString()} level=INFO msg="starting llama server" cmd="ollama runner --model ${models()}/blobs/sha256-${hex('e')} --ctx-size 4096"\n` +
          `llama_model_loader: loaded meta data from ${models()}/blobs/sha256-${hex('b')}\n`
      );
      const items = await run('ollama', ctxFor());

      expect(labels(items)).toEqual(['llama3:8b, llama3:latest', 'mistral:7b']);
      const llama = find(items, 'llama3:8b, llama3:latest');
      expect(llama).toMatchObject({ size: 5010, count: 2, lastUsed: NOW - 40 * DAY, confidence: 'low' });
      expect(llama.paths).toContain(join(models(), 'manifests/registry.ollama.ai/library/llama3/latest'));
      expect(llama.paths).not.toContain(join(models(), `blobs/sha256-${hex('c')}`));
      expect(find(items, 'mistral:7b')).toMatchObject({ size: 3020, lastUsed: NOW - 2 * DAY, confidence: 'high' });
      expect(items.flatMap((i) => i.paths ?? [i.path]).some((p) => /id_ed25519|history/.test(p))).toBe(false);
    });

    it('removes through ollama rm and rejects when the command fails', async () => {
      await library();
      const bin = await binary();
      const calls: string[][] = [];
      let code = 0;
      const ctx = ctxFor({
        exec: (file, args) => {
          calls.push([file, ...args]);
          return { code: file === bin ? code : 1, stdout: '', stderr: code ? 'model not found' : '' };
        },
      });
      const items = clean(await ollamaCollector([join(box.root, 'missing'), bin]).collect(ctx));
      const llama = find(items, 'llama3:8b, llama3:latest');
      expect(llama.removal).toBe('command');

      await llama.remove!(ctx);
      expect(calls.filter(([file]) => file === bin)).toEqual([
        [bin, 'rm', 'llama3:8b'],
        [bin, 'rm', 'llama3:latest'],
      ]);
      code = 1;
      await expect(find(items, 'mistral:7b').remove!(ctx)).rejects.toThrow('model not found');
    });

    it('only shows the models when the ollama binary is missing', async () => {
      await library();
      const items = clean(await ollamaCollector([join(box.root, 'missing')]).collect(ctxFor()));
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item).toMatchObject({ removal: 'none', blocked: 'via-app', hint: 'tool-command' });
        expect(item.remove).toBeUndefined();
      }
    });

    it('honors OLLAMA_MODELS and lets the scanner see a loaded model', async () => {
      const root = join(box.home, 'models-elsewhere');
      await library(root);
      await put(join(models(), 'manifests/registry.ollama.ai/library/ignored/latest'), '{}');
      const bin = await binary();
      const runner = proc(bin, `${bin} runner --model ${root}/blobs/sha256-${hex('e')} --port 5000`);
      const ctx = ctxFor({ env: { OLLAMA_MODELS: root }, processes: [runner] });

      const scan = await new AiScanner([ollamaCollector([bin])], async () => ctx).scan();
      expect(scan.items.map((i) => i.label).sort()).toEqual(['llama3:8b, llama3:latest', 'mistral:7b']);
      expect(scan.items.find((i) => i.label === 'mistral:7b')).toMatchObject({ blocked: 'in-use', heat: 'hot' });
    });
  });

  describe('Hugging Face', () => {
    const hub = () => join(box.home, '.cache/huggingface/hub');

    async function repo(root: string, name: string, blobs: Record<string, [number, number]>) {
      for (const [file, [size, daysAgo]] of Object.entries(blobs)) await put(join(root, name, 'blobs', file), size, daysAgo);
      const complete = Object.keys(blobs).find((file) => !file.endsWith('.incomplete'));
      if (complete) {
        const link = join(root, name, 'snapshots/abc123/model.safetensors');
        await mkdir(dirname(link), { recursive: true });
        await symlink(`../../blobs/${complete}`, link);
        const when = new Date(NOW - blobs[complete][1] * DAY);
        await lutimes(link, when, when);
        await put(join(root, name, 'refs/main'), 'abc123', blobs[complete][1]);
      }
    }

    it('lists each repo with the size of its blobs and never the token', async () => {
      await repo(hub(), 'models--mlx-community--whisper-large-v3-turbo', { h1: [3000, 30], h2: [500, 31] });
      await repo(hub(), 'datasets--org--speech', { h3: [800, 2] });
      await put(join(box.home, '.cache/huggingface/token'), 'hf_secret');
      await put(join(box.home, '.cache/huggingface/.agent_harnesses.json'), 2000);
      await put(join(box.home, '.cache/huggingface/xet/logs/xet_20260623.log'), 300, 5);

      const ctx = ctxFor();
      const items = await run('hugging-face', ctx);
      expect(labels(items)).toEqual(['mlx-community/whisper-large-v3-turbo', 'org/speech', 'xet']);
      const whisper = find(items, 'mlx-community/whisper-large-v3-turbo');
      expect(whisper).toMatchObject({
        kind: 'model',
        path: join(hub(), 'models--mlx-community--whisper-large-v3-turbo'),
        size: 3500,
        count: 2,
        lastUsed: NOW - 30 * DAY,
        confidence: 'low',
        safety: 'moderate',
        removal: 'trash',
        hint: 'redownload',
      });
      expect(whisper.paths).toBeUndefined();
      expect(ctx.isCold(whisper.lastUsed)).toBe(true);
      expect(find(items, 'org/speech')).toMatchObject({ kind: 'cache', size: 800 });
      expect(find(items, 'xet')).toMatchObject({ kind: 'cache', safety: 'safe', size: 300 });
      expect(items.some((i) => /token|agent_harnesses/.test(i.path))).toBe(false);
    });

    it('offers a stale partial download as junk apart from its repo, and holds a fresh one', async () => {
      await repo(hub(), 'models--org--partial', { done: [1000, 10], 'next.incomplete': [700, 1] });
      await repo(hub(), 'models--org--downloading', { 'big.incomplete': [900, 0] });
      const ctx = ctxFor();
      const scan = await new AiScanner([byId('hugging-face')], async () => ctx).scan();

      const partial = scan.items.filter((i) => i.label === 'org/partial');
      expect(partial.map((i) => [i.junk ?? null, i.size, i.safety]).sort()).toEqual([
        [null, 1000, 'moderate'],
        ['orphan', 700, 'safe'],
      ]);
      const downloading = scan.items.find((i) => i.label === 'org/downloading');
      expect(downloading).toMatchObject({ blocked: 'in-use', heat: 'hot', size: 900 });

      // O repositório sai por partes e deixa o parcial, que é outro item.
      const items = await byId('hugging-face').collect(ctx);
      const whole = items.find((i) => i.label === 'org/partial' && !i.junk)!;
      expect(whole.paths).toContain(join(hub(), 'models--org--partial/blobs/done'));
      expect(whole.paths).toContain(join(hub(), 'models--org--partial/snapshots'));
      expect(whole.paths).not.toContain(join(hub(), 'models--org--partial/blobs/next.incomplete'));
      expect(await whole.recheck!(ctx)).toBeNull();
      await put(join(hub(), 'models--org--partial/blobs/next.incomplete'), 700, 0);
      expect(await whole.recheck!(ctxFor())).toBe('in-use');
    });

    it('honors HF_HUB_CACHE and HF_HOME, and only shows a cache outside the account', async () => {
      await repo(join(box.home, 'hf-hub'), 'models--a--one', { x: [100, 1] });
      await repo(join(box.home, 'hf-home/hub'), 'models--b--two', { y: [100, 1] });
      await repo(join(box.tmp, 'hub'), 'models--c--three', { z: [100, 1] });

      expect(labels(await run('hugging-face', ctxFor({ env: { HF_HUB_CACHE: join(box.home, 'hf-hub') } })))).toEqual(['a/one']);
      expect(labels(await run('hugging-face', ctxFor({ env: { HF_HOME: join(box.home, 'hf-home') } })))).toEqual(['b/two']);
      const outside = await run('hugging-face', ctxFor({ env: { HF_HUB_CACHE: join(box.tmp, 'hub') } }));
      expect(outside).toHaveLength(1);
      expect(outside[0]).toMatchObject({ label: 'c/three', removal: 'none', blocked: 'via-app' });
    });
  });

  describe('Jan and GPT4All', () => {
    it('lists Jan model folders and blocks them while Jan is open', async () => {
      const data = join(box.home, 'Library/Application Support/Jan/data');
      await put(join(data, 'llamacpp/models/Menlo/Jan-nano-gguf/model.yml'), 'id: jan-nano', 20);
      await put(join(data, 'llamacpp/models/Menlo/Jan-nano-gguf/model.gguf'), 2000, 20);
      await put(join(data, 'mlx/models/qwen3-mlx/model.yml'), 'id: qwen3', 3);
      await put(join(data, 'mlx/models/qwen3-mlx/weights.safetensors'), 1000, 3);
      await put(join(data, 'threads/t1/messages.jsonl'), 500);
      await put(join(data, 'assistants/jan/assistant.json'), 500);

      const items = await run('jan');
      expect(labels(items)).toEqual(['Menlo/Jan-nano-gguf', 'qwen3-mlx']);
      expect(find(items, 'Menlo/Jan-nano-gguf')).toMatchObject({ kind: 'model', lastUsed: NOW - 20 * DAY, confidence: 'low', removal: 'trash' });

      const open = await run('jan', ctxFor({ processes: [proc('/Applications/Jan.app/Contents/MacOS/Jan')] }));
      expect(open.every((i) => i.blocked === 'app-open')).toBe(true);
    });

    it('takes only the weight files from the GPT4All folder, never the chats', async () => {
      const dir = join(box.home, 'Library/Application Support/nomic.ai/GPT4All');
      await put(join(dir, 'Meta-Llama-3-8B-Instruct.Q4_0.gguf'), 3000, 50);
      await put(join(dir, 'ggml-old.bin'), 500, 300);
      await put(join(dir, 'gpt4all-5f2a.chat'), 400);
      await put(join(dir, 'localdocs_v2.db'), 100);
      await put(join(dir, 'incomplete-mistral-7b.Q4_0.gguf'), 200, 4);

      const items = await run('gpt4all');
      expect(labels(items)).toEqual(['Meta-Llama-3-8B-Instruct.Q4_0.gguf', 'ggml-old.bin', 'mistral-7b.Q4_0.gguf']);
      expect(find(items, 'mistral-7b.Q4_0.gguf')).toMatchObject({ junk: 'orphan', safety: 'safe', kind: 'cache' });
      expect(find(items, 'ggml-old.bin')).toMatchObject({ kind: 'model', safety: 'moderate', hint: 'redownload' });
      expect(items.some((i) => /\.chat$|\.db$/.test(i.path))).toBe(false);

      const open = await run('gpt4all', ctxFor({ processes: [proc('/Applications/gpt4all/bin/gpt4all.app/Contents/MacOS/gpt4all')] }));
      expect(open.every((i) => i.blocked === 'app-open')).toBe(true);
    });

    it('follows the modelPath GPT4All saved in its settings', async () => {
      const custom = join(box.home, 'Models/gpt4all');
      await put(join(box.home, '.config/gpt4all.io/GPT4All.ini'), `[General]\nmodelPath=${custom}/\nuserDefaultModel=x\n`);
      await put(join(custom, 'phi-3.gguf'), 900, 9);
      expect(labels(await run('gpt4all'))).toEqual(['phi-3.gguf']);
    });
  });

  describe('Chrome (Gemini Nano)', () => {
    const support = () => join(box.home, 'Library/Application Support/Google');
    /** O Chrome grava microssegundos desde 1601, como texto. */
    const chromeTime = (ms: number) => String((BigInt(ms) + 11_644_473_600_000n) * 1000n);

    async function chrome() {
      await put(join(support(), 'Chrome/OptGuideOnDeviceModel/2025.8.8.1141/weights.bin'), 4000, 70);
      await put(join(support(), 'Chrome/OptGuideOnDeviceModel/2025.8.8.1141/manifest.json'), '{}', 70);
      await put(join(support(), 'Chrome/OptGuideManifestModel/5ab6799b9cd59e4f1234/1.0/weights.bin'), 800, 10);
      await put(join(support(), 'Chrome/OptGuideOnDeviceClassifierModel/2026.2.12/weights.bin'), 500, 100);
      await put(join(support(), 'Chrome/optimization_guide_model_store/43/abc/model.tflite'), 300, 100);
      await put(join(support(), 'Chrome/OptimizationGuideModelsManifest/1.2026/manifest.json'), 200, 10);
      await json(join(support(), 'Chrome/Local State'), {
        profile: { info_cache: { Default: { name: 'Pessoa' } } },
        optimization_guide: {
          model_execution: {
            last_usage_by_feature: {
              scam_detection: chromeTime(NOW - 3 * DAY),
              '15': chromeTime(NOW - 50 * DAY),
              writer: 'uninstall_requested',
            },
            manifest_asset_ledger: { '5ab6799b9cd59e4f1234': { asset_id: 'gemma_component', requested_version: '1.0' } },
          },
        },
      });
      await put(join(support(), 'Chrome Canary/OptGuideOnDeviceModel/2026.1.1.1/weights.bin'), 1000, 20);
    }

    it('reads the last on-device AI use from Local State and offers only the big models', async () => {
      await chrome();
      const ctx = ctxFor();
      const items = await run('chrome-ai', ctx);

      expect(labels(items)).toEqual(['Chrome 2025.8.8.1141', 'Chrome Canary 2026.1.1.1', 'Chrome gemma_component']);
      const nano = find(items, 'Chrome 2025.8.8.1141');
      expect(nano).toMatchObject({
        kind: 'model',
        path: join(support(), 'Chrome/OptGuideOnDeviceModel'),
        lastUsed: NOW - 3 * DAY,
        confidence: 'high',
        safety: 'moderate',
        removal: 'trash',
        hint: 'chrome-ai',
      });
      expect(ctx.isCold(nano.lastUsed)).toBe(false);
      expect(find(items, 'Chrome Canary 2026.1.1.1')).toMatchObject({ lastUsed: NOW - 20 * DAY, confidence: 'low' });
      expect(items.some((i) => /Local State|Classifier|model_store|ModelsManifest/.test(i.path))).toBe(false);
    });

    it('blocks only the channel that is open', async () => {
      await chrome();
      const stable = proc('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
      const items = await run('chrome-ai', ctxFor({ processes: [stable] }));
      expect(find(items, 'Chrome 2025.8.8.1141').blocked).toBe('app-open');
      expect(find(items, 'Chrome gemma_component').blocked).toBe('app-open');
      expect(find(items, 'Chrome Canary 2026.1.1.1').blocked).toBeUndefined();

      const canary = proc('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
      const nano = find(items, 'Chrome 2025.8.8.1141');
      expect(await nano.recheck!(ctxFor({ processes: [canary] }))).toBeNull();
      expect(await nano.recheck!(ctxFor({ processes: [stable] }))).toBe('app-open');
    });
  });

  describe('rembg, PyTorch and Whisper', () => {
    it('lists the downloaded weights with the download date', async () => {
      await put(join(box.home, '.u2net/u2net.onnx'), 1700, 200);
      await put(join(box.home, '.u2net/readme.txt'), 100);
      await put(join(box.home, '.cache/torch/hub/checkpoints/resnet50-0676ba61.pth'), 900, 15);
      await put(join(box.home, '.cache/torch/hub/pytorch_vision_main/hubconf.py'), 50, 15);
      await put(join(box.home, '.cache/torch/hub/trusted_list'), 'pytorch_vision');
      await put(join(box.home, '.cache/whisper/large-v3.pt'), 2500, 1);

      const rembg = await run('rembg');
      expect(rembg).toHaveLength(1);
      expect(rembg[0]).toMatchObject({ label: 'u2net.onnx', kind: 'model', lastUsed: NOW - 200 * DAY, confidence: 'low', hint: 'redownload' });

      const torch = await run('torch');
      expect(labels(torch)).toEqual(['pytorch_vision_main', 'resnet50-0676ba61.pth']);
      expect(find(torch, 'resnet50-0676ba61.pth')).toMatchObject({ kind: 'model', safety: 'moderate' });
      expect(find(torch, 'pytorch_vision_main')).toMatchObject({ kind: 'cache', safety: 'safe' });

      const whisper = await run('whisper');
      expect(whisper[0]).toMatchObject({ label: 'large-v3.pt', lastUsed: NOW - 1 * DAY, confidence: 'low' });
    });

    it('honors U2NET_HOME and TORCH_HOME', async () => {
      await put(join(box.home, '.u2net/u2net.onnx'), 1700);
      await put(join(box.home, 'ai/u2net/isnet.onnx'), 1000);
      await put(join(box.home, 'ai/torch/hub/checkpoints/vit.pth'), 1000);
      const ctx = ctxFor({ env: { U2NET_HOME: join(box.home, 'ai/u2net'), TORCH_HOME: '~/ai/torch' } });
      expect(labels(await run('rembg', ctx))).toEqual(['isnet.onnx']);
      expect(labels(await run('torch', ctx))).toEqual(['vit.pth']);
    });
  });

  it('finds nothing in an empty account', async () => {
    for (const collector of modelCollectors) expect(await collector.collect(ctxFor())).toEqual([]);
  });
});
