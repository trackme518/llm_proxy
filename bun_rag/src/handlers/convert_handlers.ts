import { config, logger } from "../config.js";
import { jsonResponse } from "../http.js";

const isLikelyPdf = (bytes: Uint8Array): boolean => {
  if (bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d; // %PDF-
};

const parseResponseBody = async (response: Response): Promise<{ data: any; rawText: string }> => {
  const rawText = await response.text();
  if (!rawText) {
    return { data: null, rawText };
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return { data: JSON.parse(rawText), rawText };
    } catch {
      return { data: null, rawText };
    }
  }

  return { data: rawText, rawText };
};

export async function extractMarkdownHandler(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    const contentType = req.headers.get("content-type") || "";
    logger.info({ contentType }, "extract-markdown request received");
    if (!contentType.includes("multipart/form-data")) {
      return jsonResponse({ error: "Content-Type must be multipart/form-data" }, 415);
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return jsonResponse({ error: "Invalid multipart form data" }, 400);
    }

    const filePart = formData.get("file");
    if (!(filePart instanceof File)) {
      return jsonResponse({ error: "file is required" }, 400);
    }

    const fileName = (filePart.name || "").trim();
    const isPdfByName = fileName.toLowerCase().endsWith(".pdf");
    const isPdfByType = (filePart.type || "").toLowerCase() === "application/pdf";
    if (!isPdfByName && !isPdfByType) {
      return jsonResponse({ error: "Only PDF files are supported" }, 400);
    }

    const fileBytes = new Uint8Array(await filePart.arrayBuffer());
    if (fileBytes.length === 0) {
      return jsonResponse({ error: "Uploaded file is empty" }, 400);
    }

    logger.info(
      {
        fileName: fileName || "document.pdf",
        fileType: filePart.type || "application/pdf",
        fileBytes: fileBytes.length,
      },
      "extract-markdown validated input"
    );

    if (!isLikelyPdf(fileBytes)) {
      return jsonResponse({ error: "Invalid PDF file" }, 400);
    }

    const upstreamForm = new FormData();
    upstreamForm.append("file", new File([fileBytes], fileName || "document.pdf", { type: "application/pdf" }));

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(config.CONVERT_MARKDOWN_URL, {
        method: "POST",
        body: upstreamForm,
        signal: AbortSignal.timeout(config.REQUEST_TIMEOUT),
      });
    } catch (error: any) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        return jsonResponse({ error: "Markdown conversion timed out" }, 504);
      }
      logger.error({ err: error }, "Failed to call markdown conversion service");
      return jsonResponse({ error: "Markdown conversion service unavailable" }, 502);
    }

    const { data, rawText } = await parseResponseBody(upstreamResponse);

    if (!upstreamResponse.ok) {
      logger.warn(
        {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          detail: rawText?.slice(0, 500),
        },
        "extract-markdown upstream returned non-OK status"
      );
      if (data && typeof data === "object") {
        return jsonResponse(data, upstreamResponse.status);
      }
      return jsonResponse(
        {
          error: "Markdown conversion failed",
          detail: rawText || upstreamResponse.statusText,
        },
        upstreamResponse.status
      );
    }

    const markdown = typeof data?.markdown === "string" ? data.markdown : null;
    if (markdown === null) {
      return jsonResponse({ error: "Invalid markdown conversion response" }, 502);
    }

    logger.info(
      {
        markdownChars: markdown.length,
        elapsedMs: Date.now() - startedAt,
      },
      "extract-markdown completed"
    );
    return jsonResponse({ markdown });
  } catch (error) {
    logger.error({ err: error, elapsedMs: Date.now() - startedAt }, "extract-markdown handler error");
    return jsonResponse({ error: "Failed to extract markdown" }, 500);
  }
}
