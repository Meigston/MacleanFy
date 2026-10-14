import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, LoaderCircle, Minus, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { SafetyLevel } from '../../../core/types';
import symbolUrl from '../assets/symbol.png';
import { useT } from '../i18n';
import { safetyKey } from '../i18n/strings';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'lg';
  icon?: ReactNode;
}

export function Button({ variant = 'default', size = 'md', icon, className, children, ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' && `btn--${variant}`, size === 'lg' && 'btn--lg', className];
  return (
    <button type="button" className={classes.filter(Boolean).join(' ')} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export type CheckState = 'on' | 'off' | 'mixed';

interface CheckboxProps {
  state: CheckState;
  onChange(checked: boolean): void;
  label: string;
  disabled?: boolean;
}

/** Marcador de seleção: anel vazio, preenchido quando escolhido. */
export function Checkbox({ state, onChange, label, disabled }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      className="check"
      aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange(state !== 'on');
      }}
    >
      {state === 'mixed' ? <Minus size={13} strokeWidth={3} /> : <Check size={13} strokeWidth={3} />}
    </button>
  );
}

interface SwitchProps {
  on: boolean;
  onChange(on: boolean): void;
  label: string;
  disabled?: boolean;
}

/** Liga e desliga um ajuste que vale na hora, sem botão de confirmar. */
export function Switch({ on, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="switch__thumb" />
    </button>
  );
}

const SAFETY_ICONS = { safe: ShieldCheck, moderate: ShieldAlert, risky: TriangleAlert };

/** O nível de risco nunca é só cor: vem sempre com ícone e nome. */
export function SafetyBadge({ level }: { level: SafetyLevel }) {
  const { t } = useT();
  const Icon = SAFETY_ICONS[level];
  return (
    <span className={`badge badge--${level}`}>
      <Icon size={12} />
      {t(safetyKey[level])}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle className="spinner" size={size} />;
}

/** O símbolo da marca: a onda e a estrela, sem o fundo da arte original. */
export function BrandSymbol({ size }: { size: number }) {
  return <img className="brand-symbol" src={symbolUrl} width={size} height={size} alt="" draggable={false} />;
}

interface ModalProps {
  children: ReactNode;
  /** Ausente enquanto o diálogo não pode ser fechado. */
  onClose?: () => void;
  labelledBy?: string;
}

export function Modal({ children, onClose, labelledBy }: ModalProps) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}

/** Encurta a pasta pessoal para `~`, como o Finder e o terminal mostram. */
export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}
