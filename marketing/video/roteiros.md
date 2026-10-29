# Roteiros — vídeos do MacleanFy

Identidade: Inter, o azul-marinho do fundo do app e o degradê azul → ciano do
ícone. Telas reais do app gravadas no Mac, dentro de uma janela desenhada, com
dados de demonstração (nada do disco de ninguém aparece). Tom de comercial:
frases curtas, música clássica intensa. Voz Erica, em português e inglês.

---

## Landscape 16:9, ~70 s (pt e en)

| # | Cena | Na tela | Narração (pt) | Narração (en) |
|---|---|---|---|---|
| 1 | abertura | Três chips: Disco cheio, Mac lento, Limpador por assinatura; viram o ícone | Disco cheio. Mac lento. E o limpador ainda cobra assinatura. | Disk full. Mac slow. And the cleaner wants a subscription. |
| 2 | pergunta | Ícone e "E se fosse grátis e de código aberto?" palavra por palavra | E se limpar o seu Mac fosse grátis, e de código aberto? Isso é o MacleanFy. | What if cleaning your Mac were free, and open source? This is MacleanFy. |
| 3 | visao-geral | Visão geral: saúde do disco, espaço recuperável por grupo, o que já foi liberado | Numa tela só, a saúde do Mac, o espaço que dá para recuperar e o que você já liberou. | One screen shows your Mac's health, the space you can reclaim and what you've already freed. |
| 4 | limpeza | Analisar → 17 categorias aparecendo com o nível de risco → abrir uma categoria | A limpeza inteligente varre 17 categorias: caches, logs, sobras de desenvolvimento, navegadores e duplicados. | Smart clean sweeps 17 categories: caches, logs, developer leftovers, browsers and duplicates. |
| 5 | seguranca | Só o seguro marcado → Limpar → confirmação com "Só simular" → espaço liberado | Só o que é seguro vem marcado, e nada sai do disco sem você confirmar. | Only what's safe comes ticked, and nothing leaves your disk until you confirm. |
| 6 | disco | Espaço em disco: a barra do volume, entrar numa pasta, mandar para a Lixeira | Descubra para onde foi o espaço, pasta por pasta, e mande para a Lixeira o que não serve mais. | Find out where your space went, folder by folder, and send what you don't need to the Trash. |
| 7 | desinstalador | Lista de apps → um app aberto com o que deixou na Biblioteca e no sistema → remover | O desinstalador remove o app junto com as sobras na Biblioteca e os serviços que ele instalou no sistema. | The uninstaller removes an app along with its Library leftovers and the services it installed. |
| 8 | desempenho | Desempenho ao vivo e o diagnóstico ("Ligado há 23 dias", um app preso no processador) | Mac lento? Veja processador, memória, rede e bateria ao vivo, e o que está pesando. | Mac slow? See processor, memory, network and battery live, and what's weighing it down. |
| 9 | manutencao | Manutenção: DNS, Quick Look, Spotlight, snapshots do Time Machine, rodando | E a manutenção que pedia Terminal agora é um botão. | And maintenance that used to need Terminal is now one button. |
| 10 | final | Ícone, nome, "Grátis. Código aberto.", ★ github.com/Meigston/MacleanFy, macleanfy.com | MacleanFy. Grátis e de código aberto. Gostou? Acesse o GitHub e deixe uma estrela para ajudar o projeto. | MacleanFy. Free and open source. Like it? Head to GitHub and leave a star to support the project. |

---

## Portrait 9:16, ~30 s (pt e en)

A legenda grande em cima é a própria narração; a janela do app fica embaixo.

| # | Cena | Na tela | Narração (pt) | Narração (en) |
|---|---|---|---|---|
| 1 | gancho | "Mac sem espaço?" sobre os chips | Mac sem espaço? | Mac out of space? |
| 2 | limpeza | Análise com as 17 categorias | O MacleanFy limpa 17 categorias, e só o seguro vem marcado. | MacleanFy cleans 17 categories, and only what's safe comes ticked. |
| 3 | disco | Espaço em disco, pasta por pasta | Veja para onde foi o espaço, pasta por pasta. | See where your space went, folder by folder. |
| 4 | desinstalador | Um app e tudo o que ele deixou | Desinstale apps junto com as sobras. | Uninstall apps, leftovers and all. |
| 5 | desempenho | Desempenho ao vivo e o diagnóstico | E descubra o que deixa o Mac lento. | And find out what's slowing your Mac down. |
| 6 | final | Ícone, nome, ★ GitHub | Grátis e de código aberto. Gostou? Deixe uma estrela no GitHub! | Free and open source. Like it? Leave a star on GitHub! |

---

## Observações

- Cada frase conferida no código: 17 scanners em `src/core/scanners`; só o
  seguro vem marcado (`store.ts`, `safetyLevel === 'safe'`); confirmação e
  "Só simular" antes de apagar; o desinstalador leva a Biblioteca e os
  arquivos de `/Library` (`system-files.ts`) e pode manter as configurações;
  Desempenho só lê; Manutenção com DNS, Quick Look, Spotlight e snapshots.
- Gravação: a janela do app em modo de demonstração (dados fictícios, nada
  apagado de verdade), quadro a quadro pelo próprio Electron, sem gravar a
  tela do Mac.
- Revisão independente (27/10/2026): "saúde do disco" virou "saúde do Mac" (a tela diz
  "Saúde do Mac", e é medida pelo espaço livre); o desinstalador deixou de prometer
  "tudo o que ele espalhou" (leva a Biblioteca e os serviços de /Library, não tudo).
- Licença: música e narração do Epidemic Sound fora das redes de quem assina
  pedem o plano comercial.
