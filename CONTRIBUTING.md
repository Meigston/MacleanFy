# Contribuindo

Obrigado por querer ajudar. Antes de abrir um pull request:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Regras que não se negociam

O MacleanFy apaga arquivos de quem o usa. Qualquer mudança respeita isto:

- **Analisar nunca escreve no disco.** Um scanner só lê.
- **Nada é apagado sem confirmação explícita** de uma lista que a pessoa viu.
- **A interface não dita caminhos.** Ela devolve identificadores do que o processo
  principal listou; `src/main/engine.ts` ignora o resto. Não abra um canal de IPC que
  receba um caminho arbitrário.
- **Na dúvida, o item fica de fora.** Uma categoria nova começa como `risky` e sem
  pré-seleção.
- **Comando externo é fixo e por caminho absoluto**, com `spawn`/`execFile` e nunca
  montado a partir de texto vindo da interface.

Toda regra de segurança tem teste. Se você mudar uma, mude o teste junto — e confira que
ele falha sem a regra.

## Testando sem risco

Não teste limpeza no seu disco de verdade. Os testes de `src/main/engine.test.ts` mostram o
caminho: um scanner apontado para uma pasta temporária. Na interface, a opção **Só simular**
do diálogo de limpeza percorre tudo sem apagar nada.

## Adicionando uma categoria

1. Acrescente o id e os metadados em `src/core/types.ts`.
2. Crie o scanner em `src/core/scanners/`, estendendo `BaseScanner`, com o teste ao lado.
3. Registre em `src/core/scanners/index.ts`.
4. Dê um ícone em `src/renderer/src/lib/catalog.ts` e os textos em português em
   `src/renderer/src/i18n/strings.ts` (o TypeScript reclama se faltar algum).

Se a categoria servir também para o terminal, considere propô-la ao
[mac-cleaner-cli](https://github.com/guhcostan/mac-cleaner-cli), de onde vem o motor.

## Interface

- Cores, raios e espaçamentos vêm de `src/renderer/src/theme/tokens.css`. Use os nomes,
  não valores soltos.
- O acento é linha e brilho. Botão primário é contornado, não preenchido.
- Nível de risco e estado nunca são só cor: vêm com ícone e texto.
- Texto novo entra em português e em inglês.

### Capturas de tela

Com o app compilado (`pnpm build`), esta variável salva um PNG da janela e encerra:

```bash
MACLEANFY_CAPTURE=tela.png MACLEANFY_ROUTE=smart pnpm exec electron .
```

`MACLEANFY_ROUTE` escolhe a tela (`overview`, `smart`, `system`, `development`, `storage`,
`browsers`, `large`, `uninstaller`, `maintenance`, `support`, `about`), `MACLEANFY_CAPTURE_SCRIPT`
roda um trecho de JavaScript na página antes da foto e `MACLEANFY_CAPTURE_HOVER` leva o mouse
até o elemento de um seletor CSS, para fotografar uma dica aberta.

## Commits

Mensagens curtas, no imperativo, dizendo o que muda e por quê.
