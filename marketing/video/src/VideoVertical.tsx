import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';

import { APP, TEXTOS } from './app';
import { Janela } from './Janela';
import { COR, FONTE, MONO, Selo } from './marca';
import { Chip, Estrela, FaixaCorrida, FundoClaro, FundoEscuro, Icone, useEntrada, useSaida } from './pecas';
import { existe } from './Telefone';
import { final, linha } from './linha';
import { planoVertical } from './tomadas';
import { volumeMusica } from './trilha';

/*
 * 1080×1920. As faixas de cima (~250 px) e de baixo (~350 px) ficam livres:
 * é onde o Reels, o TikTok e o Shorts põem nome, legenda e botões.
 * Cenas com papel fixo: `gancho` (texto grande sobre os chips) e `final`.
 * Qualquer outro id é cena de recurso: a legenda em cima e a janela do app embaixo,
 * com a câmera chegando perto do que acontece nela.
 */

function Gancho({ lang, quadros }: { lang: string; quadros: number }) {
  const frame = useCurrentFrame();
  const t = TEXTOS[lang];
  const tremor = (i: number) => Math.sin((frame + i * 17) / 5) * 4;
  const posicoes = [
    { y: -520, x: -40 },
    { y: -330, x: 60 },
    { y: 330, x: -30 }
  ];
  const saida = useSaida(quadros, 6);
  return (
    <FundoEscuro>
      <AbsoluteFill style={{ opacity: saida }}>
        {posicoes.map((p, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: `translate(-50%, -50%) translate(${p.x + tremor(i)}px, ${p.y}px) rotate(${(i - 1) * 5}deg)`
            }}
          >
            <div style={useEntrada(i * 5, 80)}>
              <Chip indice={i} texto={t.chips[i]} escala={1.15} />
            </div>
          </div>
        ))}
        <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div
            style={{
              fontFamily: FONTE,
              fontWeight: 800,
              fontSize: 118,
              lineHeight: 1,
              textAlign: 'center',
              color: COR.branco,
              letterSpacing: -2,
              maxWidth: 900,
              ...useEntrada(8, 40)
            }}
          >
            {t.vertical?.gancho}
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    </FundoEscuro>
  );
}

function CenaVertical({ id, lang, bloco, quadros }: { id: string; lang: string; bloco: string; quadros: number }) {
  const saida = useSaida(quadros, 6);
  const frame = useCurrentFrame();
  const aproxima = interpolate(frame, [0, quadros], [1, 1.04]);
  const cena = TEXTOS[lang].vertical?.cenas[id];
  const selo = !!(cena?.selo && APP.selo);
  const plano = planoVertical(id, lang);
  void bloco;
  return (
    <FundoClaro ladoX={50}>
      <AbsoluteFill style={{ opacity: saida }}>
        <div
          style={{
            position: 'absolute',
            top: 290,
            left: 70,
            right: 70,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 22
          }}
        >
          {selo && (
            <div style={useEntrada(2, 16)}>
              <Selo texto={APP.selo} escala={1.3} />
            </div>
          )}
          <div
            style={{
              fontFamily: FONTE,
              fontWeight: 800,
              fontSize: 74,
              lineHeight: 1.06,
              letterSpacing: -1.5,
              textAlign: 'center',
              color: COR.titulo,
              ...useEntrada(4, 30)
            }}
          >
            {cena?.legenda ?? id}
          </div>
        </div>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: selo ? 680 : 640,
            transform: `translateX(-50%) scale(${aproxima})`,
            transformOrigin: 'top center'
          }}
        >
          <div style={useEntrada(0, 120)}>
            <Janela tomadas={plano.tomadas} foco={plano.foco} largura={1030} quadros={quadros} rotulo={id} />
          </div>
        </div>
      </AbsoluteFill>
    </FundoClaro>
  );
}

function FinalVertical({ lang, bloco }: { lang: string; bloco: string }) {
  const t = TEXTOS[lang];
  const mostra = final(bloco);
  return (
    <FundoEscuro>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 44 }}>
        <Icone tamanho={240} style={useEntrada(0, 30)} />
        <div style={{ fontFamily: FONTE, fontWeight: 800, fontSize: 92, color: COR.branco, ...useEntrada(6, 20) }}>
          {APP.nome}
        </div>
        <div
          style={{
            fontFamily: FONTE,
            fontWeight: 800,
            fontSize: 74,
            lineHeight: 1.08,
            textAlign: 'center',
            color: COR.branco,
            maxWidth: 900,
            letterSpacing: -1,
            ...useEntrada(12, 30)
          }}
        >
          {t.slogan}
        </div>
        {mostra.lojas && <Estrela texto={t.estrela} repositorio={APP.repositorio} escala={1.1} style={{ marginTop: 10, ...useEntrada(18, 24) }} />}
        {mostra.site && (
          <div style={{ fontFamily: MONO, fontSize: 32, letterSpacing: 3, color: 'rgba(255,255,255,.55)', ...useEntrada(26, 20) }}>
            {APP.site}
          </div>
        )}
      </AbsoluteFill>
      <FaixaCorrida cor={COR.branco} y={1500} tamanho={26} />
    </FundoEscuro>
  );
}

export function VideoVertical({ lang, bloco = 'vertical' }: { lang: string; bloco?: string }) {
  const { trechos, total } = linha(bloco, lang);
  const musica = `musica/${bloco}-${lang}.mp3`;
  return (
    <AbsoluteFill style={{ background: COR.tinta }}>
      {trechos.map((c) => (
        <Sequence key={c.id} from={c.de} durationInFrames={c.quadros} name={c.id}>
          {c.id === 'gancho' && <Gancho lang={lang} quadros={c.quadros} />}
          {c.id === 'final' && <FinalVertical lang={lang} bloco={bloco} />}
          {c.id !== 'gancho' && c.id !== 'final' && <CenaVertical id={c.id} lang={lang} bloco={bloco} quadros={c.quadros} />}
          {existe(c.voz) && (
            <Sequence from={c.vozDe} name={`voz ${c.id}`}>
              <Audio src={staticFile(c.voz)} />
            </Sequence>
          )}
        </Sequence>
      ))}
      {existe(musica) && <Audio src={staticFile(musica)} volume={(f) => volumeMusica(f, trechos, total)} />}
    </AbsoluteFill>
  );
}
