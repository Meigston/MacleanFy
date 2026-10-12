import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { SUPPORT, crc16, parsePix, readPix } from './support';

const { renderPixQr, file } = createRequire(import.meta.url)('../../scripts/make-pix-qr.cjs') as {
  renderPixQr(payload: string): Promise<string>;
  file: string;
};

describe('support', () => {
  const { payload } = SUPPORT.pix;

  it('computes the CRC the Pix standard uses', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('ships a Pix code that passes its own check and leaves the amount open', () => {
    expect(readPix(payload)).toEqual({ amount: null, recipient: 'Meigston da Silva Ramos' });

    const fields = parsePix(payload);
    expect(fields['26']).toBe('0014BR.GOV.BCB.PIX01363da966f1-bd8d-488e-89a9-faadb0e5b63a');
    expect(fields['53']).toBe('986');
    expect(fields['54']).toBeUndefined();
    expect(fields['58']).toBe('BR');
  });

  it('reads the amount of a Pix code that fixes one', () => {
    const fixed =
      '00020126580014BR.GOV.BCB.PIX01363da966f1-bd8d-488e-89a9-faadb0e5b63a520400005303986540510.005802BR5923Meigston da Silva Ramos6009SAO PAULO62140510wgZQvZ2KYU6304BF83';
    expect(readPix(fixed)).toEqual({ amount: 10, recipient: 'Meigston da Silva Ramos' });
  });

  it('rejects a Pix code with a single character changed', () => {
    expect(readPix(payload.replace('3da966f1', '3da966f2'))).toBeNull();
    expect(readPix(payload.slice(0, -1))).toBeNull();
  });

  it('keeps the QR code image in step with the Pix code', async () => {
    expect(readFileSync(file, 'utf8')).toBe(await renderPixQr(payload));
  });
});
