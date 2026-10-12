import data from './support.json';

/**
 * Formas de apoiar o projeto. Os endereços ficam em support.json, que o script do QR
 * code também lê: depois de trocar o código Pix, rode `pnpm pix:qr`.
 */
export const SUPPORT = data;

export interface PixInfo {
  amount: number;
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
  const amount = Number(fields['54']);
  if (!fields['54'] || !Number.isFinite(amount) || !fields['59']) return null;
  return { amount, recipient: fields['59'] };
}
