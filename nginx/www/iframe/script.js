//const TOKEN_URL = "https://chat2.museumofpragueai.com/token.php";
//const RESPONSES_URL = "https://chat2.museumofpragueai.com/responses.php";

const TOKEN_URL = "/llm/auth";
const RESPONSES_URL = "/llm/responses";

import FingerprintJS from './js/finger_v5.js';
let fingerprint = null;

FingerprintJS.load()
  .then(fp => fp.get())
  .then(result => {
    fingerprint = result.visitorId;
    //console.log("Visitor ID:", result.visitorId);
  });

const bodyEl = document.body;
const toggler = document.getElementById("chatbot-toggler");
const closeBtn = document.getElementById("close-chatbot");
const chatBody = document.getElementById("chat-body");
const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const inputArea = document.getElementById("input-area");
const policyTrigger = document.getElementById("policy-trigger");

let hasShownPolicyNotice = false;
let policyMessageEl = null;

let hostViewportWidth = null;

const getHostViewportWidth = () => {
  if (Number.isFinite(hostViewportWidth) && hostViewportWidth > 0) {
    return hostViewportWidth;
  }

  try {
    return window.top?.innerWidth || window.innerWidth;
  } catch {
    return window.innerWidth;
  }
};

const syncIframeViewportMode = () => {
  const isMobile = getHostViewportWidth() <= 768;
  bodyEl.classList.toggle("iframe-mobile", isMobile);
  // console.debug("[Grifo iframe] viewport mode sync", {
  //   hostWidth: getHostViewportWidth(),
  //   isMobile,
  //   isOpen: bodyEl.classList.contains("show-chatbot"),
  // });
};

const parentOrigin = (() => {
  try {
    return document.referrer ? new URL(document.referrer).origin : "*";
  } catch {
    return "*";
  }
})();

const emitChatbotState = (isOpen, reason = "unknown") => {
  if (window.parent === window) return;

  const payload = { type: isOpen ? "grifo:open" : "grifo:close" };

  const targetOrigin = parentOrigin === "*" ? "*" : parentOrigin;

  // console.debug("[Grifo iframe] postMessage -> parent", {
  //   reason,
  //   payload,
  //   targetOrigin,
  //   parentOrigin,
  //   referrer: document.referrer || null,
  // });

  // Prefer strict target origin when available.
  window.parent.postMessage(payload, targetOrigin);
};

if (parentOrigin === "*") {
  // console.debug("[Grifo iframe] document.referrer origin unavailable; using wildcard postMessage target.");
}

window.addEventListener("message", (event) => {
  if (window.parent === window) return;
  if (event.source !== window.parent) return;

  const expectedOrigin = parentOrigin === "*" ? null : parentOrigin;
  if (expectedOrigin && event.origin !== expectedOrigin) return;

  if (event.data?.type !== "grifo:host-viewport") return;

  const nextWidth = Number(event.data?.width);
  if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;

  hostViewportWidth = nextWidth;
  syncIframeViewportMode();
});

const requestHostViewport = () => {
  if (window.parent === window) return;

  const targetOrigin = parentOrigin === "*" ? "*" : parentOrigin;
  window.parent.postMessage({ type: "grifo:request-host-viewport" }, targetOrigin);
};

let translations = null;
let currentLang = "en";
let authToken = null;
let previous_response_id = null;
let activeRequestController = null;
let activeThinkingEl = null;
let site = new URLSearchParams(window.location.search).get('site') || "web_museum_of_prague";

function sanitizeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;   // Escapes all HTML characters automatically
  return div.innerHTML;
}

//parse openai links - markdown style
function parseMarkdownLinksToAnchors(text) {
  if (typeof text !== 'string' || !text) return text;

  // Converts [label](http...) to safe anchors after the text has been sanitized.
  return text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
    if (!label || !url) return match;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
}


async function loadTranslations() {
  try {
    const response = await fetch('./assets/translations.json');
    if (!response.ok) throw new Error('Translations not found');
    return await response.json();
  } catch (e) {
    console.error("Failed to load translations.", e);
    return null;
  }
}


const createBotAvatar = () => {
  const avatar = document.createElement("img");
  avatar.className = "bot-avatar";
  avatar.src = "./assets/avatar.png";
  avatar.alt = "Bot avatar";
  return avatar;
};

const getInputText = () => input.textContent.trim();

const resetInput = () => {
  input.textContent = "";
  inputArea.classList.remove("has-text");
};

const refreshInputState = () => {
  inputArea.classList.toggle("has-text", getInputText().length > 0);
};

const addMessage = (text, role) => {
  const item = document.createElement("article");
  item.className = `message ${role}-message`;

  if (role === "bot") {
    item.appendChild(createBotAvatar());
  }

  const textEl = document.createElement("div");
  textEl.className = "message-text";
  textEl.textContent = text;
  item.appendChild(textEl);

  const imageUrl = text.match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp)/i)?.[0];
  if (imageUrl) {
    const img = document.createElement("img");
    img.className = "attachment";
    img.src = imageUrl;
    img.alt = "chat image";
    item.appendChild(img);
  }

  chatBody.appendChild(item);
  chatBody.scrollTop = chatBody.scrollHeight;
};

const addThinkingMessage = () => {
  const item = document.createElement("article");
  item.className = "message bot-message thinking";
  item.appendChild(createBotAvatar());
  item.insertAdjacentHTML("beforeend", `
    <div class="message-text">
      <div class="thinking-indicator">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    </div>
  `);
  chatBody.appendChild(item);
  chatBody.scrollTop = chatBody.scrollHeight;
  return item;
};

//expose for inline HTML / global scope
window.addMessageHtml = addMessageHtml; // or globalThis.addMessageHtml = addMessageHtml;

// Add message with HTML (for citations)
function addMessageHtml(html, role) {
  const item = document.createElement("article");
  item.className = `message ${role}-message`;
  if (role === "bot") {
    item.appendChild(createBotAvatar());
  }
  const textEl = document.createElement("div");
  textEl.className = "message-text";
  textEl.innerHTML = html;
  item.appendChild(textEl);
  chatBody.appendChild(item);
  chatBody.scrollTop = chatBody.scrollHeight;
  return item;
}

const showPolicyInChat = () => {
  if (!bodyEl.classList.contains("show-chatbot")) {
    bodyEl.classList.add("show-chatbot");
    emitChatbotState(true, "policy_click_open");
  }

  if (hasShownPolicyNotice) {
    if (policyMessageEl) {
      policyMessageEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return;
  }

  const policyTemplate = translations?.[currentLang]?.policy_notice_html
    ?? translations?.en?.policy_notice_html
    ?? "";

  const mailSubject = "GDPR";
  const mailBody = `I request to delete all my chatbot conversations with ID: ${fingerprint ?? ""}`;
  const gdprMailtoSuffix = `?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;

  const policyHtml = policyTemplate
    .replace("{{gdpr_mailto}}", gdprMailtoSuffix);

  policyMessageEl = addMessageHtml(policyHtml, "bot");
  policyMessageEl.id = "policy-message-anchor";
  hasShownPolicyNotice = true;
  policyMessageEl.scrollIntoView({ behavior: "smooth", block: "center" });
};

const resolveThinkingMessage = (thinkingEl, text) => {
  if (!thinkingEl) {
    // Use innerHTML to allow citation links
    addMessageHtml(text, "bot");
    return;
  }

  thinkingEl.classList.remove("thinking");
  const textEl = thinkingEl.querySelector(".message-text");
  textEl.innerHTML = text;

  const imageUrl = text.match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp)/i)?.[0];
  if (imageUrl) {
    const img = document.createElement("img");
    img.className = "attachment";
    img.src = imageUrl;
    img.alt = "chat image";
    thinkingEl.appendChild(img);
  }

  chatBody.scrollTop = chatBody.scrollHeight;
};

const extractFinalAssistantCompletedText = (response) => {
  if (!Array.isArray(response?.output)) return null;
  let finalText = null;
  let citations = null;

  for (const item of response.output) {
    if (item?.type === "mcp_call" && (item?.name === "search_documents" || item?.name === "deep_search")) {
      const extracted = extractCitations(item);
      if (extracted) {
        citations = extracted;
      }
    }
    if (item?.type !== "message") continue;
    if (item?.role !== "assistant") continue;
    if (item?.status !== "completed") continue;
    if (!Array.isArray(item?.content)) continue;

    for (const contentItem of item.content) {
      if (typeof contentItem?.text === "string" && contentItem.text) finalText = contentItem.text;
    }
  }

  if (!finalText) {
    console.log("No completed assistant message found in response.");
    return null;
  }
  //sanitize AI response
  let safeText = sanitizeHTML(finalText);
  //parse openai links - markdown style
  safeText = parseMarkdownLinksToAnchors(safeText);

  if (Array.isArray(citations) && citations.length > 0) {
    // citations exists and has at least one entry
    safeText = parseSources(safeText, citations);
  }

  return safeText;
};

// Extract citations from MCP tool call output
// Parse sources from finalText (e.g. [1], [2], etc.)
function normalizeForMatch(str) {
  if (str == null) return ''; // handles null and undefined
  str = String(str); // convert anything else to string
  return str
    .normalize('NFC')
    .replace(/\u00AD/g, '') // soft hyphen
    .replace(/\u00A0/g, ' ') // NBSP
    .trim()
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '') // remove common punctuation
    .replace(/\s+/g, ' '); // collapse whitespace
}

function splitIntoSentences(str) {
  if (!str) return [];
  const matches = String(str).match(/[^.!?\n]+[.!?]?/g) || [];
  return matches.map((s) => s.trim()).filter(Boolean);
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return dp[a.length][b.length];
}

function normalizedLevenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - (levenshteinDistance(a, b) / maxLen);
}

function parseSources(text, citations) {
  console.log('Input text:', text);
  console.log('Citations array:', citations);

  const regex = /【(.*?)】/g;
  if (!regex.test(text)) {
    console.log('No bracketed matches found. Returning original text.');
    return text;
  }

  const LEVENSHTEIN_THRESHOLD = 0.82;
  const normalizedCitations = citations
    .filter((cit) => !!cit?.content)
    .map((cit) => {
      const normalizedContent = normalizeForMatch(cit.content);
      const normalizedNoSpace = normalizedContent.replace(/\s+/g, '');
      const sentenceCandidates = splitIntoSentences(cit.content)
        .map((sentence) => {
          const normalizedSentence = normalizeForMatch(sentence);
          return {
            normalizedSentence,
            normalizedSentenceNoSpace: normalizedSentence.replace(/\s+/g, ''),
          };
        })
        .filter((s) => s.normalizedSentence.length > 0);

      return {
        citation: cit,
        normalizedContent,
        normalizedNoSpace,
        sentenceCandidates,
      };
    });

  regex.lastIndex = 0;
  let index = 1;

  return text.replace(regex, (_, content) => {
    const normalizedContent = normalizeForMatch(content);
    const normalizedContentNoSpace = normalizedContent.replace(/\s+/g, '');

    // 1) Normalized substring scan on full chunk + whitespace-insensitive check
    let matchedCitation = normalizedCitations.find((entry) =>
      entry.normalizedContent.includes(normalizedContent)
      || normalizedContent.includes(entry.normalizedContent)
      || entry.normalizedNoSpace.includes(normalizedContentNoSpace)
      || normalizedContentNoSpace.includes(entry.normalizedNoSpace)
    )?.citation;

    // 2) Normalized substring scan against chunk sentences
    if (!matchedCitation) {
      matchedCitation = normalizedCitations.find((entry) =>
        entry.sentenceCandidates.some((sentence) =>
          sentence.normalizedSentence.includes(normalizedContent)
          || normalizedContent.includes(sentence.normalizedSentence)
          || sentence.normalizedSentenceNoSpace.includes(normalizedContentNoSpace)
          || normalizedContentNoSpace.includes(sentence.normalizedSentenceNoSpace)
        )
      )?.citation;
    }

    // 3) Sentence-level Levenshtein fallback
    if (!matchedCitation) {
      let best = { citation: null, score: 0 };

      for (const entry of normalizedCitations) {
        for (const sentence of entry.sentenceCandidates) {
          const score = normalizedLevenshteinSimilarity(normalizedContentNoSpace, sentence.normalizedSentenceNoSpace);
          if (score > best.score) {
            best = { citation: entry.citation, score };
          }
        }
      }

      if (best.citation && best.score >= LEVENSHTEIN_THRESHOLD) {
        matchedCitation = best.citation;
        console.log(`Levenshtein fallback matched citation with score ${best.score.toFixed(3)}.`);
      }
    }

    if (matchedCitation) {
      const citationIndex = index++;
      const sanitizedSentence = sanitizeHTML(content);
      console.log(`Matched citation: "${sanitizedSentence}". Replacing with <span> #${citationIndex}`);
      return `<span class="citation-link"
      data-citation-content="${sanitizeHTML(matchedCitation.content)}"
      data-citation-excerpt="${sanitizeHTML(sanitizedSentence)}"
      data-citation-title="${sanitizeHTML(matchedCitation.title)}"
      data-citation-author="${sanitizeHTML(matchedCitation.author)}">[${citationIndex}]</span>`;
    }

    console.log(`Bracketed content "${content}" not in citations array. Removing it.`);
    return '';
  });
}
// <a onclick="addMessageHtml('${sanitizedContent}','bot')">${index++}</a>
const citationHandler = (event) => {
  const link = event.target.closest('.citation-link');
  if (!link) return;
  const citationHTML = `<span class="citation-excerpt">${link.dataset.citationExcerpt}</span>
  <br><br><span class="citation-title">${link.dataset.citationTitle}<span> 
  <span class="citation-author">${link.dataset.citationAuthor}</span>`;
  addMessageHtml(citationHTML, 'citation');
};

//repeatdly clicking will resiult in multiple bubbles - needs to be fixed
chatBody.addEventListener('click', citationHandler, { once: false });


/*
// Render message with citations and clickable bubbles
function renderMessageWithCitations(text, citations) {
  const item = document.createElement("article");
  item.className = "message bot-message citation-message";
  item.appendChild(createBotAvatar());

  const textEl = document.createElement("div");
  textEl.className = "message-text";
  textEl.innerHTML = text;
  item.appendChild(textEl);

  if (Array.isArray(citations) && citations.length > 0) {
  }

  chatBody.appendChild(item);
  chatBody.scrollTop = chatBody.scrollHeight;
}
*/

function extractCitations(item) {
  try {
    //console.log("[extractCitations] item:", item);
    const outputArr = JSON.parse(item.output);
    
    //console.log(outputArr);
    
    if (Array.isArray(outputArr) && outputArr.length > 0) {
      //LMStudio format (wraps tool call in text property)
      if (typeof outputArr[0].text === "string") {
        //console.log("item output text detected:", outputArr[0].text);
        let parsed = JSON.parse(outputArr[0].text);
        //console.log("[extractCitations] parsed:", parsed);
        return parsed; // parsed is the citations array
      }
      //OpenAI format (returns tool call directly):
      return outputArr;
    }
  } catch (e) {
    console.warn("Failed to parse citations:", e);
  }
  return null;
}

const getToken = async () => {
  try {
    const authPayload = site ? { site } : {};
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(authPayload),
    });
    const data = await res.json();
    const token = typeof data?.token === "string" ? data.token : "";
    if (!res.ok || !token) {
      console.error("getToken failed", {
        url: TOKEN_URL,
        status: res.status,
        statusText: res.statusText,
        response: data,
      });
      return null;
    }
    //console.log("Obtained token:", token);
    return token;
  } catch (err) {
    console.error("getToken failed", {
      url: TOKEN_URL,
      error: err,
    });
    return null;
  }
};

const sendMessage = async (message, thinkingEl) => {
  if (activeRequestController) {
    activeRequestController.abort();
    if (activeThinkingEl && activeThinkingEl !== thinkingEl && activeThinkingEl.isConnected) {
      activeThinkingEl.remove();
    }
  }

  const controller = new AbortController();
  activeRequestController = controller;
  activeThinkingEl = thinkingEl;

  const payload = {
    input: message,
    site: site,
    previous_response_id: previous_response_id,
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };
  if (fingerprint) {
    headers["X-Fingerprint"] = fingerprint;
  }

  try {
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();
    let data = null;

    try {
      data = JSON.parse(raw);
    } catch {
      resolveThinkingMessage(thinkingEl, "Failed to parse response ¯\\_(° -°)_/¯"); //¯\_(ツ)_/¯
      return;
    }

    if (activeRequestController !== controller) return;

    //console.log(data);
    previous_response_id = data?.id ?? previous_response_id;
    const finalText = extractFinalAssistantCompletedText(data);

    if (!finalText) {
      resolveThinkingMessage(thinkingEl, "GrifoBot is unavailable ¯\\_(° -°)_/¯.");
      return;
    }

    resolveThinkingMessage(thinkingEl, finalText);
  } catch (err) {
    if (err?.name === "AbortError") {
      if (thinkingEl && thinkingEl.isConnected) {
        thinkingEl.remove();
      }
      return;
    }

    if (activeRequestController !== controller) return;
    resolveThinkingMessage(thinkingEl, "Request failed ¯\\_(° -°)_/¯");
  } finally {
    if (activeRequestController === controller) {
      activeRequestController = null;
      activeThinkingEl = null;
    }
  }
};

// console.debug("[Grifo iframe] element availability", {
//   hasToggler: !!toggler,
//   hasCloseBtn: !!closeBtn,
//   hasChatBody: !!chatBody,
//   hasForm: !!form,
//   hasInput: !!input,
//   hasInputArea: !!inputArea,
// });

if (form && input) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = getInputText();
    if (!message) return;
    addMessage(message, "user");
    resetInput();
    const thinkingEl = addThinkingMessage();
    await sendMessage(message, thinkingEl);
  });

  input.addEventListener("input", refreshInputState);

  const submitFromKeyboard = () => {
    if (!getInputText()) return;
    form.requestSubmit();
  };

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitFromKeyboard();
    }
  });

  // Mobile keyboards can trigger paragraph insertion without reliable keydown events.
  input.addEventListener("beforeinput", (event) => {
    if (event.isComposing) return;
    if (event.inputType === "insertParagraph") {
      event.preventDefault();
      submitFromKeyboard();
    }
  });
}

syncIframeViewportMode();
window.addEventListener("resize", () => {
  syncIframeViewportMode();
  emitChatbotState(bodyEl.classList.contains("show-chatbot"), "resize");
});
window.addEventListener("orientationchange", () => {
  syncIframeViewportMode();
  emitChatbotState(bodyEl.classList.contains("show-chatbot"), "orientationchange");
});

const toggleChatbot = () => {
  const isOpen = bodyEl.classList.toggle("show-chatbot");
  // console.debug("[Grifo iframe] toggler click", { isOpen });
  emitChatbotState(isOpen, "toggler_click");
};

const closeChatbot = () => {
  bodyEl.classList.remove("show-chatbot");
  // console.debug("[Grifo iframe] close button click", { isOpen: false });
  emitChatbotState(false, "close_button_click");
};

if (toggler) {
  toggler.addEventListener("click", toggleChatbot);
}

if (closeBtn) {
  closeBtn.addEventListener("click", closeChatbot);
}

if (policyTrigger) {
  policyTrigger.addEventListener("click", showPolicyInChat);
}

emitChatbotState(bodyEl.classList.contains("show-chatbot"), "initial_state_sync");
requestHostViewport();

const triggerTogglerAttentionBounce = () => {
  if (!toggler || bodyEl.classList.contains("show-chatbot")) return;

  const cleanup = () => toggler.classList.remove("attention-bounce");

  toggler.classList.remove("attention-bounce");
  void toggler.offsetWidth;
  toggler.classList.add("attention-bounce");

  toggler.addEventListener("animationend", cleanup, { once: true });
  window.setTimeout(cleanup, 900);
};

const scheduleTogglerAttentionBounce = () => {
  window.setTimeout(triggerTogglerAttentionBounce, 1000);
};

if (document.readyState === "complete") {
  scheduleTogglerAttentionBounce();
} else {
  window.addEventListener("load", scheduleTogglerAttentionBounce, { once: true });
}

async function applyTranslations(translations, lang) {
  if (translations != null) {
    // Loop over all elements with data-i18n
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (!key) {
        console.warn('Missing data-i18n attribute on element:', el);
        return; // skip applying translation
      }
      const text = translations[lang]?.[key] ?? translations['en']?.[key] ?? null;
      if (text === null) {
        console.warn(`Missing translation for key "${key}" in "${lang}" or "en"`);
      }
      // Decide how to apply translation based on element type
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.placeholder = text;
      } else if (el.isContentEditable) {
        el.setAttribute('data-placeholder', text); // for contenteditable divs
      } else {
        el.textContent = text; // normal elements
      }
    });
  }
}

  // Auto-detect browser language
  const userLang = (navigator.language || navigator.userLanguage).split('-')[0];
  currentLang = userLang ?? 'en';
  console.log("Detected language:", currentLang);

  translations = await loadTranslations();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () =>{
      await applyTranslations(translations, currentLang);
    });
  } else {
    // DOM already ready, call it immediately
    await applyTranslations(translations, currentLang);
  }

authToken = await getToken();
//console.log("authToken:", authToken);
refreshInputState();
