// Turns an uploaded file into note text. Plain text is read as-is; a PDF with a real text layer is
// extracted locally (no AI); photos and scanned PDFs are rendered to page images and sent to /ocr,
// where the server walks its vision-model fallback chain.
import { api } from "./api";

const MAX_PAGES = 10;
const MAX_EDGE = 2000; // px on the long edge; enough for handwriting, small enough to upload quickly
const MIN_CHARS_PER_PAGE = 40; // below this a PDF page is treated as a scan

export interface ScanResult {
  text: string;
  /** Short, plain note shown under the note box; empty when there is nothing worth saying. */
  source: string;
}

export type Progress = (message: string) => void;

export const ACCEPT = ".txt,text/plain,.pdf,application/pdf,image/png,image/jpeg,image/webp";

export async function readNoteFile(file: File, progress: Progress): Promise<ScanResult> {
  const name = file.name.toLowerCase();
  if (file.type === "text/plain" || name.endsWith(".txt")) return { text: await file.text(), source: "" };
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return readPdf(file, progress);
  if (/^image\/(png|jpeg|webp)$/.test(file.type)) {
    progress("Preparing image…");
    const page = await imageToDataUrl(file);
    return ocr([page], progress);
  }
  throw new Error("Unsupported file. Use a .txt, PDF, PNG, JPEG or WebP.");
}

async function ocr(pages: string[], progress: Progress): Promise<ScanResult> {
  progress(pages.length > 1 ? `Reading ${pages.length} scanned pages with AI…` : "Reading the scan with AI…");
  const res = await api<{ text: string }>("/ocr", {
    json: { pages },
  });
  return { text: res.text, source: "Text read from your scan. Please check it against the original before saving." };
}

async function readPdf(file: File, progress: Progress): Promise<ScanResult> {
  progress("Opening PDF…");
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const count = Math.min(doc.numPages, MAX_PAGES);

  // 1. Text layer: exact and free, so try it first.
  const texts: string[] = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = "";
    const lines: string[] = [];
    for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
      line += item.str ?? "";
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      }
    }
    if (line) lines.push(line);
    texts.push(lines.join("\n").trim());
  }
  const scanned = texts.filter((t) => t.replace(/\s/g, "").length < MIN_CHARS_PER_PAGE).length;
  if (scanned === 0) {
    const joined = count > 1 ? texts.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join("\n\n") : texts[0];
    return { text: joined, source: "Text taken from your PDF." };
  }

  // 2. Scanned (image-only) PDF: render every page and OCR it.
  const pages: string[] = [];
  for (let i = 1; i <= count; i++) {
    progress(`Rendering page ${i} of ${count}…`);
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, MAX_EDGE / Math.max(base.width, base.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, viewport }).promise;
    pages.push(canvas.toDataURL("image/jpeg", 0.85));
  }
  const result = await ocr(pages, progress);
  if (doc.numPages > MAX_PAGES) result.source += ` Only the first ${MAX_PAGES} pages were read.`;
  return result;
}

async function imageToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // transparent PNGs become black in JPEG otherwise
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.88);
}
