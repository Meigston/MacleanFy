import { Composition } from 'remotion';

import './marca';
import { FPS, blocos, idiomas, layout, linha, tamanho } from './linha';
import { VideoHorizontal } from './VideoHorizontal';
import { VideoVertical } from './VideoVertical';

const COMPONENTE: Record<string, typeof VideoHorizontal> = { horizontal: VideoHorizontal, vertical: VideoVertical };

/** Uma composição por vídeo e idioma que tenha falas em roteiro.json: `<vídeo>-<idioma>`. */
export function Root() {
  return (
    <>
      {blocos().flatMap((bloco) => {
        const [width, height] = tamanho(bloco);
        return idiomas(bloco).map((lang) => (
          <Composition
            key={`${bloco}-${lang}`}
            id={`${bloco}-${lang}`}
            component={COMPONENTE[layout(bloco)]}
            defaultProps={{ lang, bloco }}
            durationInFrames={linha(bloco, lang).total}
            fps={FPS}
            width={width}
            height={height}
          />
        ));
      })}
    </>
  );
}
