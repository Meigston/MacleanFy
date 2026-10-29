# Vídeos de divulgação

Montados em código com [Remotion](https://www.remotion.dev) (React), com as
telas reais do MacleanFy gravadas pelo próprio app. Uma composição por formato
e idioma que tenha falas em `roteiro.json`:

| Composição | Formato | Para onde |
|---|---|---|
| `horizontal-pt`, `horizontal-en` | 1920×1080, ~65 s | README, YouTube, site |
| `vertical-pt`, `vertical-en` | 1080×1920, ~25 s | Reels, TikTok, Shorts e Status |

- `roteiro.json`: as cenas de cada formato, o tempo extra de cada uma, a
  narração por idioma (como se escreve, que é o que vai para a legenda), a
  `pronuncia` ("17" → "dezessete"), a voz e a música.
- `src/app.ts`: identidade (nome, site, repositório, cores, fonte) e os textos da tela.
- `src/tomadas.ts`: o trecho de cada gravação em cada cena.
- `src/Janela.tsx`: a janela do macOS em volta da gravação, e o zoom do vertical.
- `cenas/<cena>.mjs`: o roteiro de cada gravação (onde o cursor vai, o que clica).
- `roteiros.md`: o roteiro aprovado.

Licença do Remotion: gratuita para pessoa física e empresa de até três
pessoas; acima disso, licença de empresa.

## Gravar as telas

As telas são gravadas pelo próprio app, fora da tela (renderização offscreen do
Electron, a 2×), sem permissão de captura e sem aparecer no monitor. A gravação
liga o modo de demonstração (`src/main/demo.ts`): um Mac fictício de 512 GB
quase cheio, apps, pastas e processos inventados, e nada é apagado de verdade.
O cursor é desenhado na página pelo gravador (`src/main/record.ts`).

```bash
cd ../.. && corepack pnpm build && cd marketing/video
bash scripts/gravar.sh limpeza smart pt     # public/brutos/mac/pt/limpeza.mp4 e .json com as marcas de tempo
```

| Cena | Rota |
|---|---|
| `visao-geral` | `overview` |
| `limpeza`, `seguranca` | `smart` |
| `disco` | `disk` |
| `desinstalador` | `uninstaller` |
| `desempenho` | `performance` |
| `manutencao` | `maintenance` |

O gravador é determinístico: as tomadas em pt e en saem com os mesmos tempos, e
os cortes de `src/tomadas.ts` valem para as duas.

## O que não está no repositório

A pasta `public/` fica fora do git. Para renderizar de novo, ela precisa ter:

- `fonts/Inter.woff2` (de `@fontsource-variable/inter`, o pacote do app) e
  `marca/icon.png` (o `build/icon.png` do app, recortado em 824 px sem a margem).
- `brutos/mac/<idioma>/<cena>.mp4`: as gravações, por `scripts/gravar.sh`.
- `voz/<formato>-<idioma>-NN.mp3`: a narração, gerada no Epidemic Sound
  (`GenerateVoiceover`) com a voz Erica, uma por cena. Os ids estão em `voz-ids.txt`.
- `musica/<formato>-<idioma>.mp3`: Vivaldi, Verão, Presto (Odyssey Orchestra,
  no Epidemic), cortada pelo próprio Epidemic (`EditRecording` com
  `forceDuration`) na duração de cada composição. Os jobs estão em `voz-ids.txt`.

Música e narração do Epidemic fora das redes sociais de quem assina (site,
README, app) pedem o plano comercial.

## Renderizar

```bash
npm ci
node scripts/falas.mjs horizontal        # o texto de cada fala para o GenerateVoiceover (com a pronúncia)
node scripts/normalizar.mjs              # nivela voz (-16 LUFS) e música (-18); originais em public/originais/
node scripts/manifesto.mjs               # mede public/ e escreve src/manifesto.json
npx remotion studio src/index.ts         # para ver e ajustar
bash scripts/render.sh horizontal        # saida/horizontal-<idioma>.mp4
bash scripts/render.sh vertical          # saida/vertical-<idioma>.mp4
bash scripts/conferir.sh saida/horizontal-pt.mp4
bash scripts/web.sh horizontal <destino> macleanfy 17   # mp4 da web, pôster e legenda
CRF=26 bash scripts/web.sh horizontal ../../docs/video macleanfy 17   # o do README, abaixo de 10 MB
```

Com o Mac bloqueado, o processo de GPU do Chrome do Remotion cai ("Target
closed", "icudtl.dat not found"). O `render.sh` já usa `scripts/chrome.sh`, que
roda a GPU no mesmo processo; para o `still` e o `compositions`, passar
`--browser-executable=$PWD/scripts/chrome.sh`.
