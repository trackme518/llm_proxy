import { chunkText, type ChunkingOptions, type TextChunk } from "../chunking.js";

const logChunks = (label: string, chunks: TextChunk[]) => {
  console.log(`\n${label}`);
  chunks.forEach((chunk, index) => {
    console.log(`Chunk ${index + 1}: start=${chunk.start}, length=${chunk.text.length}`);
    console.log(chunk.text.replace(/\n/g, "\\n"));
  });
};

const runTestCase = async (label: string, text: string, options: ChunkingOptions) => {
  const chunks = await chunkText(text, options);
  logChunks(label, chunks);
};

export const runSemanticChunkTextTests = async () => {
  await runTestCase(
    "Short paragraphs",
    "First paragraph. It has two sentences.\n\nSecond paragraph is here. It is shorter.",
    {
      strategy: "semantic",
      maxChars: 80,
      overlapChars: 0,
      minChars: 30
    }
  );

  await runTestCase(
    "Long sentence slicing",
    "This is a single sentence that should be long enough to exceed the max chunk size, so it will be sliced into multiple units for testing purposes without introducing additional punctuation to split it further.",
    {
      strategy: "semantic",
      maxChars: 60,
      overlapChars: 0,
      minChars: 20
    }
  );

  await runTestCase(
    "Mixed paragraph sizes",
    "Alpha sentence one. Alpha sentence two.\n\nBeta sentence one is longer than the previous sentences and should test chunk packing behavior. Beta sentence two.\n\nGamma.",
    {
      strategy: "semantic",
      maxChars: 90,
      overlapChars: 0,
      minChars: 35
    }
  );
};

export const runAllChunkingTests = async () => {
  await runSemanticChunkTextTests();
};

if (import.meta.main) {
  runAllChunkingTests().catch((error) => {
    console.error("Chunking tests failed", error);
  });
}
