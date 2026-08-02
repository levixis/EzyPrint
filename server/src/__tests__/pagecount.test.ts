/**
 * Unit Tests — server-side page counting.
 *
 * The browser posts a page count with each order, and price is
 * pageCount × rate × copies. Understating it understates the bill, so the
 * server must derive the figure it bills against from the bytes it received.
 */

import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { countPages } from '../services/pagecount.service';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Build a real PDF with a known number of pages. */
async function pdfWithPages(n: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

/**
 * Build a minimal .pptx with a known number of slides.
 *
 * Only the parts the counter looks at are present — a real deck carries far
 * more, but the slide parts are what determine the count.
 */
async function pptxWithSlides(n: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('ppt/presentation.xml', '<presentation/>');
  for (let i = 1; i <= n; i++) {
    zip.file(`ppt/slides/slide${i}.xml`, '<sld/>');
  }
  return zip.generateAsync({ type: 'nodebuffer' });
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

  /**
   * PPTX is offered by the file picker, so it must be priceable. When it was
   * not, `repriceFromVerifiedPages` marked every deck unverifiable and checkout
   * refused with "please re-upload this file" — which could never succeed,
   * because re-uploading produced the same result. Every PPTX order was
   * unpayable, and nothing failed anywhere to say so.
   */
  describe('pptx', () => {
    test('counts the slides in a deck', async () => {
      const buf = await pptxWithSlides(24);
      await expect(countPages(buf, PPTX_MIME)).resolves.toEqual({ pages: 24, counted: true });
    });

    test('a single-slide deck counts as one', async () => {
      const buf = await pptxWithSlides(1);
      await expect(countPages(buf, PPTX_MIME)).resolves.toEqual({ pages: 1, counted: true });
    });

    test('counts past slide9, where string ordering stops matching numeric', async () => {
      const buf = await pptxWithSlides(12);
      await expect(countPages(buf, PPTX_MIME)).resolves.toEqual({ pages: 12, counted: true });
    });

    test('ignores non-slide parts in the same archive', async () => {
      const zip = new JSZip();
      zip.file('ppt/slides/slide1.xml', '<sld/>');
      zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships/>');
      zip.file('ppt/slideLayouts/slideLayout1.xml', '<sldLayout/>');
      zip.file('ppt/slideMasters/slideMaster1.xml', '<sldMaster/>');
      const buf = await zip.generateAsync({ type: 'nodebuffer' });

      await expect(countPages(buf, PPTX_MIME)).resolves.toEqual({ pages: 1, counted: true });
    });

    test('a deck with no slides is uncounted rather than zero pages', async () => {
      // Zero would price the order as free.
      const buf = await pptxWithSlides(0);
      await expect(countPages(buf, PPTX_MIME)).resolves.toEqual({ pages: 0, counted: false });
    });

    test('a file that is not a readable zip is reported uncounted', async () => {
      const result = await countPages(Buffer.from('not a pptx at all'), PPTX_MIME);
      expect(result).toEqual({ pages: 0, counted: false });
    });
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
