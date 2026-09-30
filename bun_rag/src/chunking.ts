export interface TextChunk {
  text: string;
  start: number;  // Character position where chunk starts in original text
  paragraphEnd?: boolean;
  summary?: string;
}

export type ChunkingStrategy = "semantic" | "fixed";

export interface ChunkingOptions {
  strategy: ChunkingStrategy;
  maxChars: number;
  overlapChars: number;
  minChars: number;
  language?: string;
}

export async function chunkText(text: string, options: ChunkingOptions): Promise<TextChunk[]> {
  if (!text) return [];
  options.strategy = options.strategy ?? "semantic";
  options.maxChars = Math.min(4096, Math.max(100, options.maxChars ?? 1000));
  //5-50% overlap allowed, 25% of maxChars by default
  options.overlapChars = Math.min(Math.floor(options.maxChars * 0.5), Math.max(Math.floor(options.maxChars * 0.05), Math.floor(options.overlapChars ?? options.maxChars * 0.25)));
  options.minChars = Math.max(0, Math.min(options.maxChars, Math.floor(options.minChars ?? 0)));

  if (options.strategy === "fixed") {
    return fixedChunkText(text, options);
  }

  return semanticChunkText(text, options);
}

//--------------------------------------------------------------------------------------
// Sentence-first semantic chunking with paragraph boundary flags and minChars enforcement
const semanticChunkText = (text: string, options: ChunkingOptions): TextChunk[] => {
  const rawUnits = sentenceSplit(text, true, options.language ?? "en");
  const units: TextChunk[] = [];

  for (let index = 0; index < rawUnits.length; index++) {
    if (rawUnits[index].text.length <= options.maxChars) {
      units.push(rawUnits[index]);
      continue;
    }

    for (let offset = 0; offset < rawUnits[index].text.length; offset += options.maxChars) {
      units.push({
        text: rawUnits[index].text.slice(offset, offset + options.maxChars),
        start: rawUnits[index].start + offset,
        paragraphEnd: rawUnits[index].paragraphEnd && offset + options.maxChars >= rawUnits[index].text.length
      });
    }
  }

  if (units.length === 0) {
    return [];
  }

  const createEmptyChunk = (): TextChunk => ({
    text: "",
    start: 0
  });

  const canAppend = (chunk: TextChunk, unit: TextChunk, options: ChunkingOptions) =>
    chunk.text.length + unit.text.length <= options.maxChars;

  const appendUnit = (chunk: TextChunk, unit: TextChunk) => {
    if (chunk.text.length === 0) {
      chunk.start = unit.start;
    }
    chunk.text += unit.text;
  };

  const cannotGrowFurther = (chunk: TextChunk, nextUnit: TextChunk | null, options: ChunkingOptions) =>
    !nextUnit || chunk.text.length + nextUnit.text.length > options.maxChars;

  const finalizeChunk = (chunk: TextChunk): TextChunk => ({
    text: chunk.text,
    start: chunk.start
  });

  const pushChunk = (chunk: TextChunk, options: ChunkingOptions, nextUnit: TextChunk | null) => {
    if (chunk.text.length === 0) {
      return null;
    }
    if (chunk.text.length >= options.minChars) {
      return finalizeChunk(chunk);
    }
    if (cannotGrowFurther(chunk, nextUnit, options)) {
      return finalizeChunk(chunk);
    }
    return null;
  };

  const packedChunks: TextChunk[] = [];
  let currChunk = createEmptyChunk();

  for (let index = 0; index < units.length; index++) {
    if (canAppend(currChunk, units[index], options)) {
      appendUnit(currChunk, units[index]);
      continue;
    }

    const flushed = pushChunk(currChunk, options, units[index]);
    if (flushed !== null) {
      packedChunks.push(flushed);
      currChunk = createEmptyChunk();
    }

    appendUnit(currChunk, units[index]);
  }

  const finalChunk = pushChunk(currChunk, options, null);
  if (finalChunk !== null) {
    packedChunks.push(finalChunk);
  }

  return createOverlappedChunks(packedChunks, units, options);
};

const createOverlappedChunks = (packedChunks: TextChunk[], units: TextChunk[], options: ChunkingOptions): TextChunk[] => {
  const overlappedChunks: TextChunk[] = [];
  let unitCursor = 0;

  for (let index = 0; index < packedChunks.length; index++) {
    //find the original sentence which starts position is equal to current Chunk
    while (unitCursor < units.length && units[unitCursor].start !== packedChunks[index].start) {
      unitCursor += 1;
    }

    let startUnitIndex = unitCursor;
    let endUnitIndex = startUnitIndex;
    let totalLength = 0;

    while (endUnitIndex < units.length && totalLength < packedChunks[index].text.length) {
      totalLength += units[endUnitIndex].text.length;
      endUnitIndex += 1;
    }

    if (totalLength < packedChunks[index].text.length) {
      continue;
    }

    endUnitIndex -= 1;

    // Limit backward expansion to the configured overlap budget and max chunk size.
    const overlapLimit = Math.max(0, Math.min(options.overlapChars, options.maxChars - totalLength));
    let overlapLength = 0;

    while (
      index > 0 &&
      startUnitIndex > 0 &&
      overlapLength + units[startUnitIndex - 1].text.length <= overlapLimit &&
      totalLength + units[startUnitIndex - 1].text.length <= options.maxChars
    ) {
      startUnitIndex -= 1;
      overlapLength += units[startUnitIndex].text.length;
      totalLength += units[startUnitIndex].text.length;
    }

    let combinedText = "";
    for (let unitIndex = startUnitIndex; unitIndex <= endUnitIndex; unitIndex++) {
      combinedText += units[unitIndex].text;
    }

    if (combinedText.length > 0) {
      overlappedChunks.push({ text: combinedText, start: units[startUnitIndex].start });
    }

    unitCursor = endUnitIndex + 1;
  }

  return overlappedChunks;
};

//--------------------------------------------------------------------------------------
//Naive, simple chunking by fixed character count + overlap - OpenAI style
const fixedChunkText = (text: string, options: ChunkingOptions): TextChunk[] => {
  if (!text) return [];
  const safeMax = Math.max(1, Math.floor(options.maxChars));
  const defaultOverlap = Math.floor(safeMax / 2);
  const overlap = Math.max(0, Math.min(Math.floor(options.overlapChars ?? defaultOverlap), safeMax - 1));
  const step = Math.max(1, safeMax - overlap);

  const chunks: TextChunk[] = [];
  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(start + safeMax, text.length);
    const chunkText = text.slice(start, end);
    if (chunkText.length === 0) break;
    chunks.push({ text: chunkText, start });
    if (end >= text.length) break;
  }

  return chunks;
};

//--------------------------------------------------------------------------------------
// Sentence splitting using built-in Intl.Segmenter (locale-aware, no external deps).
// Language should be a BCP 47 language tag (e.g. "en", "fr", "zh-CN").
export function sentenceSplit(text: string, detectParagraphs = false, language = "en"): TextChunk[] {
  if (!text) return [];

  const toChunks = (segments: Array<{ segment: string; index: number }>): TextChunk[] => {
    const chunks: TextChunk[] = [];

    for (let i = 0; i < segments.length; i++) {
      const segmentText = segments[i].segment;
      const start = segments[i].index;
      if (!segmentText || segmentText.length === 0) continue;

      const end = start + segmentText.length;
      const hasParagraphBreak = detectParagraphs && /^\s*\n\s*\n/.test(text.slice(end));
      chunks.push({
        text: segmentText,
        start,
        paragraphEnd: hasParagraphBreak || i === segments.length - 1,
      });
    }

    return chunks;
  };

  try {
    const locale = language?.trim() || "en";
    const segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
    const segments = Array.from(segmenter.segment(text), (s) => ({
      segment: s.segment,
      index: s.index,
    }));
    const chunks = toChunks(segments);
    if (chunks.length > 0) return chunks;
  } catch {
    // Fallback for invalid locale or unavailable segmenter behavior.
  }

  const fallbackSegments = Array.from(text.matchAll(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g), (m) => ({
    segment: m[0],
    index: m.index ?? 0,
  }));
  return toChunks(fallbackSegments);
}
//--------------------------------------------------------------------------------------