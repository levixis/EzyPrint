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

export interface PageCountResult {
  pages: number;
  /** False when the format is one we cannot introspect. */
  counted: boolean;
}

/**
 * Count the pages in an uploaded file.
 *
 * Returns `counted: false` for formats we cannot parse (Office documents, plain
 * text). Callers decide what to do about that — pricing treats an uncounted
 * file as unverifiable rather than silently trusting the client.
 */
export async function countPages(buffer: Buffer, mimeType: string): Promise<PageCountResult> {
  if (SINGLE_PAGE_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return { pages: 1, counted: true };
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
