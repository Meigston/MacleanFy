<p align="center">
  <img src="assets/brand/logo.png" alt="MacleanFy" width="520">
</p>

<p align="center">
  Limpeza do Mac com interface gráfica, de código aberto.<br>
  <a href="README.en.md">English</a>
</p>

![Visão geral do MacleanFy](docs/screenshots/visao-geral.png)

## Baseado no mac-cleaner-cli

O MacleanFy é baseado no **[guhcostan/mac-cleaner-cli](https://github.com/guhcostan/mac-cleaner-cli)**,
uma ferramenta de terminal publicada sob a licença MIT. Os scanners e as regras de segurança
vêm de lá; o MacleanFy acrescenta a interface gráfica. O detalhe do que foi copiado, do que
mudou e do que é novo está em [NOTICE.md](NOTICE.md).

Se você prefere o terminal, use o projeto original.

## O que ele faz

**Visão geral.** Saúde do disco, espaço recuperável por grupo, o que já foi liberado e
recomendações do que limpar primeiro.

**Limpeza.** Dezesseis categorias em cinco grupos. Cada uma traz o nível de risco, e dá para
abrir a categoria e escolher item a item.

| Grupo | Categorias |
| --- | --- |
| Lixo do sistema | cache de aplicativos, logs, temporários, arquivos de idioma, launch agents órfãos |
| Desenvolvimento | caches de npm/Yarn/pnpm/pip/Gradle/Cargo/CocoaPods/Xcode, Homebrew, Docker, `node_modules` parados |
| Armazenamento | Lixeira, downloads antigos, backups do iOS, anexos do Mail, arquivos duplicados |
| Navegadores | cache do Chrome, Safari, Firefox e Arc |
| Arquivos grandes | arquivos acima de 500 MB em Downloads e Documentos |

**Desinstalador.** Lista os aplicativos com o tamanho do app e dos arquivos que ele deixou
na Biblioteca, e manda tudo para a Lixeira.

**Manutenção.** Limpar o cache de DNS e liberar espaço purgável.

![Limpeza inteligente](docs/screenshots/limpeza.png)

## Segurança

Um limpador apaga arquivos. Estas são as travas:

- **Analisar só lê.** Nada é apagado antes de você conferir a lista e confirmar.
- **Só o que é seguro vem marcado.** Categorias moderadas e arriscadas esperam a sua escolha.
  O Docker também, porque a limpeza dele é um `docker system prune -af`.
- **Itens arriscados pedem uma confirmação a mais**, e o diálogo mostra o aviso de cada um.
- **Dá para simular.** A opção "Só simular" percorre tudo sem apagar nada.
- **Caminhos do sistema são intocáveis.** `/System`, `/usr`, `/bin`, `/etc` e afins são
  recusados na remoção e nem chegam a aparecer na lista.
- **Temporários em uso ficam de fora.** Só entra o que está parado há mais de um dia;
  soquetes e pastas com atividade recente nunca entram.
- **A interface não dita caminhos.** O processo que apaga só aceita o que a última análise
  devolveu. A interface roda isolada, sem acesso ao Node nem ao disco.
- **Desinstalar é reversível.** Os apps vão para a Lixeira.

A limpeza das categorias **é permanente**: os arquivos não passam pela Lixeira.

## Como rodar

Requisitos: macOS 12 ou mais novo, Node 22 e [pnpm](https://pnpm.io).

```bash
git clone https://github.com/Meigston/MacleanFy.git
cd MacleanFy
pnpm install
pnpm dev
```

### Gerar o instalador

```bash
pnpm dist
```

Saem dois instaladores em `dist/`:

| Arquivo | Para |
| --- | --- |
| `MacleanFy-<versão>-arm64.dmg` | Macs com Apple Silicon (M1 ou mais novo) |
| `MacleanFy-<versão>-x64.dmg` | Macs com Intel |

Abra o `.dmg` e arraste o MacleanFy para a pasta Aplicativos.

Sem certificado o build sai com assinatura ad-hoc: abre no Mac em que foi compilado, mas o
macOS o bloqueia em qualquer outro para onde for copiado ou baixado. Ainda não há um
instalador assinado e notarizado para baixar.

### Assinar e notarizar

Para distribuir, o instalador precisa de um certificado *Developer ID Application* e da
notarização da Apple. Com o certificado no Keychain:

```bash
export CSC_NAME="Seu Nome (TEAMID)"
export APPLE_API_KEY=/caminho/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
pnpm dist
```

No lugar da chave de API servem um perfil do `notarytool` (`APPLE_KEYCHAIN_PROFILE`) ou
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID`. Nenhuma dessas credenciais
entra no repositório.

### Acesso Total ao Disco

Sem essa permissão o macOS esconde a Lixeira, o Mail e o Safari, e a análise mostra essas
categorias vazias. Conceda em **Ajustes do Sistema → Privacidade e Segurança → Acesso Total
ao Disco** — o app tem um atalho em *Sobre e ajustes*. Em desenvolvimento a permissão vale
para o terminal de onde você rodou `pnpm dev`.

## Como o projeto está organizado

```
src/
  core/       motor: scanners, regras de segurança e desinstalação (derivado do mac-cleaner-cli)
  main/       processo principal do Electron: análise, limpeza, histórico e sistema
  preload/    a única ponte entre a interface e o processo principal
  shared/     o contrato dessa ponte
  renderer/   a interface em React
```

| Comando | O que faz |
| --- | --- |
| `pnpm dev` | abre o app com recarga automática |
| `pnpm test` | roda os testes |
| `pnpm typecheck` | checa os tipos |
| `pnpm lint` | roda o ESLint |
| `pnpm build` | compila para `out/` |
| `pnpm dist` | compila e empacota o `.dmg` |
| `pnpm icon` | refaz o ícone do app a partir do símbolo |

## Design

A interface segue o Nocturne, o sistema de design do
[Airdroidfy](https://airdroidfy.com): superfícies escuras, elevação feita de borda de 1px e
uma regra que atravessa tudo — o acento é linha e brilho, nunca um bloco de cor. O acento é
o azul → ciano da logo. Os tokens ficam em
[`src/renderer/src/theme/tokens.css`](src/renderer/src/theme/tokens.css).

As cores dos gráficos não são as da marca de propósito: foram validadas para o fundo escuro
e para daltonismo.

## Contribuindo

Problemas, ideias de categoria e pull requests são bem-vindos. Veja
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[MIT](LICENSE). Partes do código vêm do mac-cleaner-cli, também sob MIT — veja
[NOTICE.md](NOTICE.md).

O MacleanFy apaga arquivos. É distribuído sem garantia: confira a lista antes de confirmar e
mantenha um backup do que importa.
