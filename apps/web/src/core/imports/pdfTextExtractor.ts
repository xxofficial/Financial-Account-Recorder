import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export class PdfTextExtractionError extends Error {
  constructor(message: string, readonly needsPassword = false) {
    super(message);
    this.name = 'PdfTextExtractionError';
  }
}

type PdfTextItem = { str: string; transform: number[]; width: number };
type PdfContentValue = { str?: unknown; transform?: unknown; width?: unknown };

const isPdfTextItem = (value: unknown): value is PdfTextItem => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as PdfContentValue;
  return typeof candidate.str === 'string' && Array.isArray(candidate.transform) && typeof candidate.width === 'number';
};

/**
 * Browser-side extraction for text PDFs. The text is kept in memory only and
 * passed to the shared deterministic broker parsers; no PDF or password enters
 * IndexedDB or any backup file.
 */
export async function extractPdfText(file: File, password?: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({ data: bytes, password: password || undefined });
  try {
    const document = await task.promise;
    try {
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        // PDF.js returns a visual stream rather than logical paragraphs. Keep
        // each rendered row separate: the shared broker parsers intentionally
        // operate on statement table rows and headings.
        const lines: Array<{ y: number; parts: Array<{ x: number; width: number; text: string }> }> = [];
        for (const item of (content.items as unknown[]).filter(isPdfTextItem)) {
          const y = item.transform[5];
          let line: (typeof lines)[number] | undefined;
          for (let index = lines.length - 1; index >= 0; index -= 1) {
            if (Math.abs(lines[index].y - y) <= 2) {
              line = lines[index];
              break;
            }
          }
          if (!line) {
            line = { y, parts: [] };
            lines.push(line);
          }
          if (item.str) line.parts.push({ x: item.transform[4], width: item.width, text: item.str });
        }
        const pageText = lines.map((line) => {
          let right = Number.NEGATIVE_INFINITY;
          return line.parts.sort((left, rightPart) => left.x - rightPart.x).map((part) => {
            const gap = part.x - right;
            const characterWidth = Math.abs(part.width) / Math.max(part.text.length, 1);
            const separator = right > Number.NEGATIVE_INFINITY && gap > Math.max(1.5, characterWidth * 0.45) ? ' ' : '';
            right = Math.max(right, part.x + Math.abs(part.width));
            return `${separator}${part.text}`;
          }).join('').trim();
        }).filter(Boolean).join('\n');
        if (pageText) pages.push(pageText);
      }
      const text = pages.join('\n').trim();
      if (!text) throw new PdfTextExtractionError('未从 PDF 提取到文字。扫描件不受支持，请使用可复制文本的电子结单。');
      return text;
    } finally {
      await document.destroy();
    }
  } catch (error) {
    if (error instanceof PdfTextExtractionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const needsPassword = /password|encrypted/i.test(message);
    throw new PdfTextExtractionError(
      needsPassword ? '该 PDF 已加密，请输入结单密码后重新解析。' : `PDF 文本提取失败：${message}`,
      needsPassword,
    );
  } finally {
    await task.destroy();
  }
}
