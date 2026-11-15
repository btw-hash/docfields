import { getDocumentProxy } from 'unpdf';

export class InputError extends Error {}

interface Piece {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function joinLine(pieces: Piece[]): string {
  const sorted = [...pieces].sort((a, b) => a.x - b.x);
  let line = '';
  let end = 0;
  sorted.forEach((p, i) => {
    if (i > 0) {
      const gap = p.x - end;
      const unit = Math.max(p.height, 1);
      if (gap > unit * 0.6) line += '  ';
      else if (gap > unit * 0.12 && !line.endsWith(' ') && !p.str.startsWith(' ')) line += ' ';
    }
    line += p.str;
    end = p.x + p.width;
  });
  return line.replace(/[ \t]+$/, '');
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch {
    throw new InputError('The file could not be read as a PDF.');
  }
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const pieces: Piece[] = [];
    for (const item of content.items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      pieces.push({
        str: item.str,
        x: item.transform[4] ?? 0,
        y: item.transform[5] ?? 0,
        width: item.width,
        height: item.height || Math.abs(item.transform[3] ?? 10),
      });
    }
    pieces.sort((a, b) => b.y - a.y);
    const lines: Piece[][] = [];
    for (const p of pieces) {
      const last = lines[lines.length - 1];
      const ref = last?.[0];
      if (last && ref && Math.abs(ref.y - p.y) <= Math.min(ref.height, p.height) * 0.45) last.push(p);
      else lines.push([p]);
    }
    pages.push(lines.map(joinLine).join('\n'));
  }
  return pages.join('\n\n').trim();
}
