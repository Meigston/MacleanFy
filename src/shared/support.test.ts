import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { PIX_OPTIONS, SUPPORT, crc16, isPixOption, parsePix, readPix } from './support';

const { renderPixQr, qrFile } = createRequire(import.meta.url)('../../scripts/make-pix-qr.cjs') as {
  renderPixQr(payload: string): Promise<string>;
  qrFile(option: string): string;
};

const KEY_FIELD = '0014BR.GOV.BCB.PIX01363da966f1-bd8d-488e-89a9-faadb0e5b63a';

describe('support', () => {
  it('computes the CRC the Pix standard uses', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('ships one Pix code of R$ 10 and one that leaves the amount open', () => {
    expect(PIX_OPTIONS).toEqual(['fixed', 'open']);
    expect(readPix(SUPPORT.pix.fixed)).toEqual({ amount: 10, recipient: 'Meigston da Silva Ramos' });
    expect(readPix(SUPPORT.pix.open)).toEqual({ amount: null, recipient: 'Meigston da Silva Ramos' });
    expect(parsePix(SUPPORT.pix.open)['54']).toBeUndefined();
  });

  it.each(PIX_OPTIONS)('pays the same key in Brazilian reais with the %s code', (option) => {
    const fields = parsePix(SUPPORT.pix[option]);
    expect(fields['26']).toBe(KEY_FIELD);
    expect(fields['53']).toBe('986');
    expect(fields['58']).toBe('BR');
  });

  it.each(PIX_OPTIONS)('rejects the %s code with a single character changed', (option) => {
    const payload = SUPPORT.pix[option];
    expect(readPix(payload.replace('3da966f1', '3da966f2'))).toBeNull();
    expect(readPix(payload.slice(0, -1))).toBeNull();
  });

  it.each(PIX_OPTIONS)('keeps the QR code image of the %s code in step with it', async (option) => {
    expect(readFileSync(qrFile(option), 'utf8')).toBe(await renderPixQr(SUPPORT.pix[option]));
  });

  it('only accepts the Pix options it ships', () => {
    expect(isPixOption('fixed')).toBe(true);
    expect(isPixOption('open')).toBe(true);
    expect(isPixOption('toString')).toBe(false);
    expect(isPixOption(SUPPORT.pix.fixed)).toBe(false);
    expect(isPixOption(undefined)).toBe(false);
  });

  it('points the donation link at Stripe', () => {
    expect(SUPPORT.stripe).toMatch(/^https:\/\/donate\.stripe\.com\/[A-Za-z0-9]+$/);
  });
});
