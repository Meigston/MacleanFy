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

  it('ships a Pix code that passes its own check and pays R$ 10 in Brazil', () => {
    expect(readPix(payload)).toEqual({ amount: 10, recipient: 'Meigston da Silva Ramos' });

    const fields = parsePix(payload);
    expect(fields['26']).toContain('BR.GOV.BCB.PIX');
    expect(fields['53']).toBe('986');
    expect(fields['58']).toBe('BR');
  });

  it('rejects a Pix code with a single character changed', () => {
    expect(readPix(payload.replace('10.00', '90.00'))).toBeNull();
    expect(readPix(payload.slice(0, -1))).toBeNull();
  });

  it('keeps the QR code image in step with the Pix code', async () => {
    expect(readFileSync(file, 'utf8')).toBe(await renderPixQr(payload));
  });

  it('points the donation links at Stripe and GitHub Sponsors', () => {
    expect(SUPPORT.stripe).toMatch(/^https:\/\/donate\.stripe\.com\/[A-Za-z0-9]+$/);
    expect(SUPPORT.sponsors).toMatch(/^https:\/\/github\.com\/sponsors\/[A-Za-z0-9-]+$/);
  });
});
