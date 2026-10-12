# Créditos e origem do código

O MacleanFy é baseado no **[mac-cleaner-cli](https://github.com/guhcostan/mac-cleaner-cli)**,
de [guhcostan](https://github.com/guhcostan) e colaboradores, publicado sob a licença MIT.
O texto original da licença está em [`licenses/mac-cleaner-cli-LICENSE`](licenses/mac-cleaner-cli-LICENSE).

O mac-cleaner-cli é uma ferramenta de terminal. O MacleanFy reaproveita o motor dela — os
scanners e as regras de segurança — e acrescenta uma interface gráfica.

## O que veio do mac-cleaner-cli

Ponto de partida: versão **1.3.1**, commit
[`fb35a9b`](https://github.com/guhcostan/mac-cleaner-cli/commit/fb35a9b07ad4f7fd59579b9b7c95ba36d10b3cf6).

| No MacleanFy | No mac-cleaner-cli | Situação |
| --- | --- | --- |
| `src/core/types.ts` | `src/types.ts` | cópia |
| `src/core/scanners/*.ts` | `src/scanners/*.ts` | cópia, com as mudanças abaixo |
| `src/core/utils/{fs,paths,size,hash}.ts` | `src/utils/{fs,paths,size,hash}.ts` | cópia, com as mudanças abaixo |
| `src/core/apps.ts` | `src/commands/uninstall.ts` | derivado: a lógica de localizar e remover apps, sem os prompts de terminal |
| `src/main/system.ts` (manutenção) | `src/maintenance/*.ts` | derivado: os mesmos comandos, com autenticação pelo diálogo do macOS |
| os `*.test.ts` ao lado de cada arquivo acima | os testes correspondentes | cópia |

## O que mudou em relação ao original

- **`src/core/utils/fs.ts`** — os tamanhos passaram a ser o espaço ocupado em disco
  (`sizeOnDisk`), não o tamanho aparente. Um arquivo esparso como o `Docker.raw` declara
  centenas de GB e ocupa uma fração disso.
- **`src/core/scanners/large-files.ts`** — usa o mesmo critério de espaço em disco.
- **`src/core/scanners/index.ts`** — ficou só o registro dos scanners. As funções
  `runScans`/`runAllScans` saíram: o app tem o próprio executor em `src/main/engine.ts`.
- **`src/core/utils/index.ts`** — exporta só o que o app usa. Barra de progresso, backup,
  configuração e seletores de terminal ficaram no projeto original.
- **`src/core/scanners/launch-agents.ts`** e **`launch-agents.test.ts`** — ajustes para
  passar no lint e na checagem de tipos, sem mudança de comportamento.

## O que é novo

Tudo fora de `src/core/` é do MacleanFy: o processo principal do Electron (`src/main`), a
ponte para a interface (`src/preload`, `src/shared`) e a interface em React (`src/renderer`).

Algumas regras existem só aqui, porque numa interface gráfica limpar é um clique:

- arquivos temporários só são oferecidos depois de um dia parados, e nunca soquetes ou
  pastas com atividade recente;
- itens em caminhos protegidos do sistema não aparecem na lista;
- a interface só pode pedir a remoção de caminhos devolvidos pela última análise;
- o desinstalador manda os apps para a Lixeira em vez de apagar de forma definitiva.

## Identidade visual

O sistema de design segue o Nocturne, do [Airdroidfy](https://airdroidfy.com). A fonte é a
[Inter](https://rsms.me/inter/) (SIL Open Font License) e os ícones são do
[Lucide](https://lucide.dev) (ISC).
