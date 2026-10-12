import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const SIDES = ['right', 'left', 'top', 'bottom'] as const;
type Side = (typeof SIDES)[number];

interface Tip {
  text: string;
  side: Side;
  anchor: DOMRect;
}

/** Distância entre a dica e o elemento. */
const GAP = 9;
/** Distância mínima da borda da janela. */
const EDGE = 8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * A dica de `data-tip`, desenhada uma vez para a janela inteira.
 *
 * Ela fica fora dos cartões porque eles cortam o que passa da borda: presa ao próprio
 * elemento, a dica perdia parte do texto. Aqui ela fica por cima de tudo e não sai da janela.
 */
export function Tooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;

    const show = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tip]') : null;
      if (target === current) return;
      current = target;

      const text = target?.dataset.tip;
      if (!target || !text) return setTip(null);
      const side = SIDES.find((option) => option === target.dataset.tipPos) ?? 'right';
      setTip({ text, side, anchor: target.getBoundingClientRect() });
    };
    const hide = () => {
      current = null;
      setTip(null);
    };

    document.addEventListener('mouseover', show);
    document.addEventListener('mousedown', hide);
    document.addEventListener('scroll', hide, true);
    document.documentElement.addEventListener('mouseleave', hide);
    return () => {
      document.removeEventListener('mouseover', show);
      document.removeEventListener('mousedown', hide);
      document.removeEventListener('scroll', hide, true);
      document.documentElement.removeEventListener('mouseleave', hide);
    };
  }, []);

  // Só depois de desenhada dá para saber o tamanho da dica; ela aparece já no lugar.
  useLayoutEffect(() => {
    const element = box.current;
    if (!tip || !element) return;

    const { width, height } = element.getBoundingClientRect();
    const { anchor, side } = tip;
    const centeredX = anchor.left + anchor.width / 2 - width / 2;
    const centeredY = anchor.top + anchor.height / 2 - height / 2;
    const place = {
      right: { left: anchor.right + GAP, top: centeredY },
      left: { left: anchor.left - GAP - width, top: centeredY },
      top: { left: centeredX, top: anchor.top - GAP - height },
      bottom: { left: centeredX, top: anchor.bottom + GAP },
    }[side];

    element.style.left = `${clamp(place.left, EDGE, window.innerWidth - width - EDGE)}px`;
    element.style.top = `${clamp(place.top, EDGE, window.innerHeight - height - EDGE)}px`;
    element.style.visibility = 'visible';
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} className="tip" role="tooltip">
      {tip.text}
    </div>
  );
}
