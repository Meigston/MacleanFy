import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';

import { APP, TEXTOS, type Cena } from './app';
import { Janela } from './Janela';
import { COR, FONTE, MONO, Selo } from './marca';
import { Chip, Estrela, FaixaCorrida, FundoClaro, FundoEscuro, Icone, useEntrada, useSaida } from './pecas';
import { existe } from './Telefone';
import { final, linha } from './linha';
import { planoHorizontal } from './tomadas';
import { volumeMusica } from './trilha';

/*
 * 1920×1080. Cenas com papel fixo: `abertura` (os três chips espalhados que
 * viram o ícone), `pergunta` e `final`. Qualquer outro id de roteiro.json é
 * cena de recurso: a janela do app de um lado, o texto do outro, alternando.
 */
const ESPECIAIS = new Set(['abertura', 'pergunta', 'final']);

function Abertura({ lang, quadros }: { lang: string; quadros: number }) {
  const frame = useCurrentFrame();
  const t = TEXTOS[lang];
  // Os três chips flutuam espalhados e, no último terço, voam para o centro e viram o ícone.
  const junta = interpolate(frame, [quadros * 0.62, quadros * 0.9], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
  const posicoes = [
    { x: -560, y: -230, atraso: 0 },
    { x: 470, y: -40, atraso: 18 },
    { x: -330, y: 250, atraso: 36 }
  ];
  const icone = interpolate(frame, [quadros * 0.82, quadros], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <FundoEscuro>
      {posicoes.map((p, i) => {
        const entra = useEntrada(p.atraso, 60);
        const flutua = Math.sin((frame + i * 40) / 22) * 10;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: `translate(-50%, -50%) translate(${p.x * (1 - junta)}px, ${(p.y + flutua) * (1 - junta)}px) scale(${1 - junta * 0.7}) rotate(${(i - 1) * 4 * (1 - junta)}deg)`,
              opacity: (entra.opacity as number) * (1 - junta)
            }}
          >
            <Chip indice={i} texto={t.chips[i]} escala={1.25} />
          </div>
        );
      })}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Icone tamanho={220} style={{ opacity: icone, transform: `scale(${0.6 + icone * 0.4})` }} />
      </AbsoluteFill>
    </FundoEscuro>
  );
}

function Pergunta({ lang, quadros }: { lang: string; quadros: number }) {
  const t = TEXTOS[lang];
  const saida = useSaida(quadros);
  const palavras = t.pergunta.split(' ');
  return (
    <FundoEscuro>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity: saida, gap: 48, flexDirection: 'column' }}>
        <Icone tamanho={150} style={useEntrada(0, 20)} />
        <div
          style={{
            maxWidth: 1400,
            textAlign: 'center',
            fontFamily: FONTE,
            fontWeight: 800,
            fontSize: 92,
            lineHeight: 1.08,
            color: COR.branco,
            letterSpacing: -1.5
          }}
        >
          {palavras.map((p, i) => (
            <span key={i} style={{ display: 'inline-block', marginRight: 22, ...useEntrada(6 + i * 3, 30) }}>
              {p}
            </span>
          ))}
        </div>
      </AbsoluteFill>
      <FaixaCorrida cor={COR.branco} y={940} />
    </FundoEscuro>
  );
}

function Texto({ cena, largura }: { cena: Cena; largura: number }) {
  return (
    <div style={{ width: largura, display: 'flex', flexDirection: 'column', gap: 26 }}>
      {cena.selo && APP.selo && (
        <div style={useEntrada(4, 20)}>
          <Selo texto={APP.selo} />
        </div>
      )}
      {cena.kicker && (
        <div
          style={{
            fontFamily: FONTE,
            fontWeight: 800,
            fontSize: 24,
            letterSpacing: 4,
            textTransform: 'uppercase',
            color: COR.secundaria,
            ...useEntrada(6, 20)
          }}
        >
          {cena.kicker}
        </div>
      )}
      <div
        style={{
          fontFamily: FONTE,
          fontWeight: 800,
          fontSize: 68,
          lineHeight: 1.04,
          letterSpacing: -1.5,
          color: COR.titulo,
          ...useEntrada(10, 30)
        }}
      >
        {cena.titulo}
      </div>
      {cena.apoio && (
        <div
          style={{
            fontFamily: FONTE,
            fontWeight: 500,
            fontSize: 31,
            lineHeight: 1.38,
            color: COR.corpo,
            ...useEntrada(16, 24)
          }}
        >
          {cena.apoio}
        </div>
      )}
    </div>
  );
}

function CenaRecurso({ id, lang, bloco, quadros, indice }: { id: string; lang: string; bloco: string; quadros: number; indice: number }) {
  const t = TEXTOS[lang];
  const esquerda = indice % 2 === 0;
  const saida = useSaida(quadros);
  const plano = planoHorizontal(id, lang);
  const janela = useEntrada(0, 70);
  void bloco;
  return (
    <FundoClaro ladoX={esquerda ? 34 : 66}>
      <AbsoluteFill
        style={{
          flexDirection: esquerda ? 'row' : 'row-reverse',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 84,
          opacity: saida
        }}
      >
        <div style={janela}>
          <Janela tomadas={plano.tomadas} foco={plano.foco} largura={1150} quadros={quadros} rotulo={`${id} (${lang})`} />
        </div>
        <Texto cena={t.cenas[id] ?? { titulo: id }} largura={560} />
      </AbsoluteFill>
    </FundoClaro>
  );
}

function Final({ lang, bloco }: { lang: string; bloco: string }) {
  const t = TEXTOS[lang];
  const mostra = final(bloco);
  return (
    <FundoEscuro>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 30 }}>
        <Icone tamanho={170} style={useEntrada(0, 30)} />
        <div style={{ fontFamily: FONTE, fontWeight: 800, fontSize: 60, color: COR.branco, ...useEntrada(6, 20) }}>
          {APP.nome}
        </div>
        <div
          style={{
            fontFamily: FONTE,
            fontWeight: 800,
            fontSize: 84,
            letterSpacing: -1.5,
            color: COR.branco,
            textAlign: 'center',
            maxWidth: 1500,
            ...useEntrada(12, 30)
          }}
        >
          {t.slogan}
        </div>
        {mostra.lojas && <Estrela texto={t.estrela} repositorio={APP.repositorio} style={{ marginTop: 16, ...useEntrada(22, 24) }} />}
        {mostra.site && (
          <div style={{ fontFamily: MONO, fontSize: 26, letterSpacing: 3, color: 'rgba(255,255,255,.55)', ...useEntrada(30, 20) }}>
            {APP.site}
          </div>
        )}
      </AbsoluteFill>
    </FundoEscuro>
  );
}

export function VideoHorizontal({ lang, bloco = 'horizontal' }: { lang: string; bloco?: string }) {
  const { trechos, total } = linha(bloco, lang);
  const musica = `musica/${bloco}-${lang}.mp3`;
  let recurso = 0;
  return (
    <AbsoluteFill style={{ background: COR.tinta }}>
      {trechos.map((c) => {
        const indice = ESPECIAIS.has(c.id) ? -1 : recurso++;
        return (
          <Sequence key={c.id} from={c.de} durationInFrames={c.quadros} name={c.id}>
            {c.id === 'abertura' && <Abertura lang={lang} quadros={c.quadros} />}
            {c.id === 'pergunta' && <Pergunta lang={lang} quadros={c.quadros} />}
            {c.id === 'final' && <Final lang={lang} bloco={bloco} />}
            {indice >= 0 && <CenaRecurso id={c.id} lang={lang} bloco={bloco} quadros={c.quadros} indice={indice} />}
            {existe(c.voz) && (
              <Sequence from={c.vozDe} name={`voz ${c.id}`}>
                <Audio src={staticFile(c.voz)} />
              </Sequence>
            )}
          </Sequence>
        );
      })}
      {existe(musica) && <Audio src={staticFile(musica)} volume={(f) => volumeMusica(f, trechos, total)} />}
    </AbsoluteFill>
  );
}
