import data from './support.json';

/**
 * Como apoiar o projeto. Os códigos Pix e o link de doação ficam em support.json, que o
 * script dos QR codes também lê: depois de trocar um código, rode `pnpm pix:qr`.
 */
export const SUPPORT = data;

/** Os dois códigos Pix: um com valor de referência, outro em que quem paga escolhe. */
export type PixOption = keyof typeof data.pix;

export const PIX_OPTIONS = Object.keys(data.pix) as PixOption[];

export function isPixOption(value: unknown): value is PixOption {
  return typeof value === 'string' && (PIX_OPTIONS as string[]).includes(value);
}

export interface PixInfo {
  /** null quando o código deixa quem paga escolher o valor. */
  amount: number | null;
  recipient: string;
}

/** CRC-16/CCITT-FALSE, o verificador que fecha todo código Pix. */
export function crc16(text: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(text)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Separa os campos de um código Pix "copia e cola": dois dígitos de id, dois de tamanho, o valor. */
export function parsePix(payload: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let at = 0;
  while (at + 4 <= payload.length) {
    const length = Number(payload.slice(at + 2, at + 4));
    if (!Number.isInteger(length)) break;
    fields[payload.slice(at, at + 2)] = payload.slice(at + 4, at + 4 + length);
    at += 4 + length;
  }
  return fields;
}

/** Valor e recebedor de um código Pix, ou null se ele não fechar com o próprio verificador. */
export function readPix(payload: string): PixInfo | null {
  const body = payload.slice(0, -4);
  if (!body.endsWith('6304') || crc16(body) !== payload.slice(-4)) return null;

  const fields = parsePix(payload);
  const amount = fields['54'] ? Number(fields['54']) : null;
  if ((amount !== null && !Number.isFinite(amount)) || !fields['59']) return null;
  return { amount, recipient: fields['59'] };
}
