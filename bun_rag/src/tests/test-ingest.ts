import { callResponses } from "../llm.js";

type QuestionCase = {
  question: string;
  expectedOneWord: string;
};

const API_BASE_URL = "http://127.0.0.1:3000";
const API_KEY = process.env.DEFAULT_ADMIN_API_KEY ??  "";
const API_AUTH_HEADER = API_KEY.startsWith("Bearer ") ? API_KEY : `Bearer ${API_KEY}`;
const TEST_LLM_TIMEOUT_MS = 60000;
const DEFAULT_ORGANIZATION_ID = 1;
const DEFAULT_PROJECT_ID = 1;

const SAMPLE_FACTS = [
  "The project codename is Nebula.",
  "The launch city is Brno.",
  "The support email is helpdesk@nebula.test.",
  "The release year is 2027.",
  "The legal owner is AcmeLabs.",
  "The default currency is Euro.",
  "The safety color is Orange.",
  "The mobile app name is SkyTrack.",
  "The hardware revision is R4.",
  "The backup window starts at 02:00 UTC.",
].join("\n");

const QUESTIONS: QuestionCase[] = [
  { question: "What is the project codename?", expectedOneWord: "Nebula" },
  { question: "What is the launch city?", expectedOneWord: "Brno" },
  { question: "Which currency is default?", expectedOneWord: "Euro" },
  { question: "What is the safety color?", expectedOneWord: "Orange" },
];

const parseJsonSafe = async (response: Response): Promise<any> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const ingestSampleDocument = async (): Promise<number> => {
  const payload = {
    title: "Ten Facts Test Document",
    author: "Test Runner",
    summary: "Synthetic 10-facts dataset for retrieval verification.",
    domain: "qa",
    keywords: ["facts", "test", "verification"],
    date_published: "2026-03-14",
    language: "en",
    chunking_strategy: "semantic",
    chunk_max_chars: 1000,
    content: SAMPLE_FACTS,
    document_text: SAMPLE_FACTS,
    organization_id: DEFAULT_ORGANIZATION_ID,
    project_id: DEFAULT_PROJECT_ID,
  };

  const response = await fetch(`${API_BASE_URL}/documents/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_AUTH_HEADER,
    },
    body: JSON.stringify(payload),
  });

  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw new Error(`Ingest failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const documentId = Number(data?.document_id);
  if (!Number.isInteger(documentId) || documentId <= 0) {
    throw new Error(`Ingest response missing document_id: ${JSON.stringify(data)}`);
  }

  console.log("Ingest response:", JSON.stringify(data, null, 2));
  return documentId;
};

const listDocumentIds = async (): Promise<number[]> => {
  const response = await fetch(`${API_BASE_URL}/api/tools/list-documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_AUTH_HEADER,
    },
    body: JSON.stringify({
      organization_id: DEFAULT_ORGANIZATION_ID,
      project_id: DEFAULT_PROJECT_ID,
    }),
  });

  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw new Error(`list-documents failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const ids = (Array.isArray(data?.documents) ? data.documents : [])
    .map((d: any) => Number(d?.document_id))
    .filter((id: number) => Number.isInteger(id) && id > 0);

  if (!ids.length) {
    throw new Error("No document IDs returned from list-documents.");
  }

  return ids;
};

const extractCitationCodes = (answer: string): string[] => {
  const bracketMatch = answer.match(/\[([^\]]+)\]/);
  if (!bracketMatch) {
    return [];
  }

  const parts = bracketMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return [];
  }

  const codePattern = /^#[0-9A-Fa-f]{2}-[0-9A-Fa-f]{4}#$/;
  if (!parts.every((part) => codePattern.test(part))) {
    return [];
  }

  return Array.from(new Set(parts.map((part) => part.toUpperCase())));
};

const verifyAnswerFormat = (answer: string, expectedWord: string) => {
  const citedCodes = extractCitationCodes(answer);
  const normalizedAnswer = answer.replace(/\[[^\]]+\]/g, "").trim();
  const oneWord = normalizedAnswer.split(/\s+/)[0] ?? "";
  const hasCitationFormat = citedCodes.length > 0;
  const matchesWord = oneWord.toLowerCase() === expectedWord.toLowerCase();
  return {
    matchesWord,
    hasCitationFormat,
    oneWord,
    citedCodes,
  };
};

const askWithMcp = async (
  questionCase: QuestionCase,
  documentIds: number[]
): Promise<string | null> => {
  const prompt = `
    You have MCP tools available.
    Use search_documents for retrieval.
    Return exactly in this format: "one-word-answer [citation-codes]",
    "Citation codes must be in format #chunkIndex-hexSentence# and can be repeated as a comma-separated list.",
    "Example: Nebula [#16-00FF#,#12-0001#]",
    Question: ${questionCase.question}`;

  return callResponses({
    prompt,
    requestTimeoutMs: TEST_LLM_TIMEOUT_MS,
    mcpServer: {
      serverLabel: "rag-mcp",
      serverUrl: `${API_BASE_URL}/mcp`,
      authorization: API_AUTH_HEADER,
      allowedTools: ["search_documents", "list_projects"],
      requireApproval: "never",
    },
  });
};

async function main() {
  if (!API_KEY) {
    throw new Error("Missing DEFAULT_ADMIN_API_KEY env var.");
  }
  //console.log(`Key used: ${API_KEY.slice(0, 12)}...`);

  console.log(`Using default scope organization_id=${DEFAULT_ORGANIZATION_ID}, project_id=${DEFAULT_PROJECT_ID}`);
  console.log("Step 1/4: ingesting sample 10-facts document...");
  const ingestedDocumentId = await ingestSampleDocument();

  console.log("Step 2/4: loading document ids...");
  const listedIds = await listDocumentIds();
  const documentIds = Array.from(new Set([ingestedDocumentId, ...listedIds]));

  console.log("Step 3/4: asking LLM with MCP tools (search_documents)...");
  const verificationResults: Array<{
    question: string;
    expected: string;
    answer: string;
    pass: boolean;
    formatOk: boolean;
  }> = [];

  for (const q of QUESTIONS) {
    console.log(`Calling LLM for: ${q.question} (search_documents)`);
    const answer = (await askWithMcp(q, documentIds)) ?? "";
    console.log(`LLM returned for: ${q.question}`);
    console.log("Raw answer (escaped):", JSON.stringify(answer));
    console.log("Raw answer (verbatim):");
    console.log(answer);
    const verification = verifyAnswerFormat(answer, q.expectedOneWord);
    const pass = verification.matchesWord && verification.hasCitationFormat;

    console.log("---");
    console.log(`Question: ${q.question}`);
    console.log("Mode: search_documents");
    console.log(`Answer: ${answer}`);
    console.log(`Expected first word: ${q.expectedOneWord}`);
    console.log(`Verification: pass=${pass}, formatOk=${verification.hasCitationFormat}`);

    verificationResults.push({
      question: q.question,
      expected: q.expectedOneWord,
      answer,
      pass,
      formatOk: verification.hasCitationFormat,
    });
  }

  console.log("Step 4/4: summary");
  const passed = verificationResults.filter((r) => r.pass).length;
  console.log(`Passed ${passed}/${verificationResults.length}`);

  const failed = verificationResults.filter((r) => !r.pass);
  if (failed.length) {
    console.log("Failures:");
    for (const item of failed) {
      console.log(JSON.stringify(item, null, 2));
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("test-ingest failed:", error);
  process.exit(1);
});
