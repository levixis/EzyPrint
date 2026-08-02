import { PDFDocument } from 'pdf-lib';

/**
 * Counting pages from the bytes the server actually received.
 *
 * The browser also counts pages, and posts the result with the order. That
 * number decides the price, so it cannot be the number we bill against — a
 * client that declares a 200-page PDF as 1 page pays for one page and gets two
 * hundred printed, with the shop absorbing the difference.
 *
 * Counted at upload rather than at checkout because the bytes are already in
 * memory here, so verification costs nothing extra and never sits in the
 * payment path.
 */

/** Anything that isn't a PDF is a single page — images print one to a sheet. */
const SINGLE_PAGE_MIME_PREFIXES = ['image/'];

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * Count slides in a PPTX.
 *
 * A .pptx is a zip; each slide is one `ppt/slides/slideN.xml` entry, and only
 * the entry names are needed, so nothing is decompressed. This is deliberately
 * the same algorithm as `parseDocument` in `components/student/FileUploadForm.tsx`
 * — the student is quoted from the browser's count and charged from this one,
 * and two different ways of counting the same deck is how the quote and the
 * charge come to disagree.
 *
 * Without this, PPTX was accepted by the picker and by upload but could not be
 * priced, so `repriceFromVerifiedPages` reported it unverifiable and checkout
 * refused with "please re-upload this file" — advice that could never work,
 * because re-uploading produced the same result. PPTX orders were unpayable.
 */
async function countPptxSlides(buffer: Buffer): Promise<PageCountResult> {
  try {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buffer);

    let slides = 0;
    zip.folder('ppt/slides/')?.forEach((relativePath, entry) => {
      if (!entry.dir && relativePath.startsWith('slide') && relativePath.endsWith('.xml')) {
        slides++;
      }
    });

    // A presentation with no slide parts is not something we can price from —
    // it is either corrupt or not really a deck. Zero would price as free.
    return slides > 0 ? { pages: slides, counted: true } : { pages: 0, counted: false };
  } catch {
    // Not a readable zip. The shop may still be able to open it, so the upload
    // stands; it just cannot be priced from.
    return { pages: 0, counted: false };
  }
}

export interface PageCountResult {
  pages: number;
  /** False when the format is one we cannot introspect. */
  counted: boolean;
}

/**
 * Count the pages in an uploaded file.
 *
 * Covers every format the student-facing picker offers: PDF, PPTX and images.
 * Returns `counted: false` for anything else (Word, Excel, plain text — types
 * the upload middleware still accepts for ticket attachments, which are never
 * priced). Callers decide what to do about that; pricing treats an uncounted
 * file as unverifiable rather than silently trusting the client.
 *
 * Anything added to `SUPPORTED_FILE_TYPES` in `constants.ts` needs a branch
 * here too, or it can be uploaded and then never paid for.
 */
export async function countPages(buffer: Buffer, mimeType: string): Promise<PageCountResult> {
  if (SINGLE_PAGE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return { pages: 1, counted: true };
  }

  if (mimeType === PPTX_MIME) {
    return countPptxSlides(buffer);
  }

  if (mimeType === 'application/pdf') {
    try {
      // ignoreEncryption matches the browser's parse: a password-protected PDF
      // still reports a page count, and refusing here would block orders the
      // shop can print perfectly well.
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      const pages = doc.getPageCount();
      // A malformed PDF that parses to zero pages must not price as free.
      return pages > 0 ? { pages, counted: true } : { pages: 0, counted: false };
    } catch {
      // Corrupt or unsupported PDF. Not an error the upload should fail on —
      // the file may still be printable — but not something we can price from.
      return { pages: 0, counted: false };
    }
  }

  return { pages: 0, counted: false };
}
