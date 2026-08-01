/**
 * Unit Tests — server-side page counting.
 *
 * The browser posts a page count with each order, and price is
 * pageCount × rate × copies. Understating it understates the bill, so the
 * server must derive the figure it bills against from the bytes it received.
 */

import { PDFDocument } from 'pdf-lib';
import { countPages } from '../services/pagecount.service';

/** Build a real PDF with a known number of pages. */
async function pdfWithPages(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

describe('countPages', () => {
  test('counts the real pages of a multi-page PDF', async () => {
    const buf = await pdfWithPages(200);
    await expect(countPages(buf, 'application/pdf')).resolves.toEqual({ pages: 200, counted: true });
  });

  test('a single-page PDF counts as one', async () => {
    const buf = await pdfWithPages(1);
    await expect(countPages(buf, 'application/pdf')).resolves.toEqual({ pages: 1, counted: true });
  });

  test('images are one page without parsing', async () => {
    await expect(countPages(Buffer.from('not really a jpeg'), 'image/jpeg'))
      .resolves.toEqual({ pages: 1, counted: true });
  });

  test('a corrupt PDF is reported uncounted rather than as zero pages', async () => {
    // Returning 0 would price the order as free.
    const result = await countPages(Buffer.from('%PDF-1.4 garbage'), 'application/pdf');
    expect(result.counted).toBe(false);
  });

  test('formats we cannot introspect are reported uncounted', async () => {
    const result = await countPages(Buffer.from('anything'), 'application/msword');
    expect(result).toEqual({ pages: 0, counted: false });
  });

  test('the count does not depend on what the client claimed', async () => {
    // The attack: declare a 200-page PDF as 1 page to pay for one page.
    const buf = await pdfWithPages(200);
    const claimed = 1;
    const { pages } = await countPages(buf, 'application/pdf');
    expect(pages).not.toBe(claimed);
    expect(pages).toBe(200);
  });
});
