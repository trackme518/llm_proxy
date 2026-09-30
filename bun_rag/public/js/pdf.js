const PDF_WORKER_SRC = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624/build/pdf.worker.min.mjs";

export function getPdfLib() {
  const lib = window.pdfjsLib;
  if (lib && lib.GlobalWorkerOptions) {
    lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }
  return lib;
}

const extractPageText = async (page) => {
  const textContent = await page.getTextContent();
  const pageText = (textContent?.items ?? [])
    .map((item) => String(item?.str ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return pageText;
};

const extractTextInBatches = async (pdfDoc, batchSize = 10) => {
  const numPages = pdfDoc.numPages;
  const allTexts = [];

  for (let i = 1; i <= numPages; i += batchSize) {
    const batchEnd = Math.min(i + batchSize - 1, numPages);
    const batchPageNumbers = Array.from({ length: batchEnd - i + 1 }, (_, j) => i + j);

    const batchTexts = await Promise.all(
      batchPageNumbers.map(async (pageNum) => {
        const page = await pdfDoc.getPage(pageNum);
        try {
          return await extractPageText(page);
        } finally {
          page.cleanup();
        }
      })
    );

    allTexts.push(...batchTexts);
  }

  return allTexts.join("\n\n").trim();
};

export async function extractTextFromPdfArrayBuffer(arrayBuffer, options = {}) {
  const pdfLib = getPdfLib();
  if (!pdfLib) {
    throw new Error("PDF parser not available");
  }

  const batchSize = Number.isFinite(Number(options.batchSize))
    ? Math.max(1, Math.floor(Number(options.batchSize)))
    : 10;

  const pdfDoc = await pdfLib.getDocument({ data: arrayBuffer }).promise;

  try {
    return await extractTextInBatches(pdfDoc, batchSize);
  } finally {
    pdfDoc.destroy();
  }
}
