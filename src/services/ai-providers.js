/**
 * Default system prompt for translation with Markdown preservation
 */
const DEFAULT_SYSTEM_PROMPT = `You are a professional translator. Translate the user's text from {sourceLang} to {targetLang}.

RULES:
1. Keep all Markdown symbols (**, _, ~~, \`, \`\`\`, -, <u>) exactly as they are.
2. DO NOT translate content inside backticks (\`...\`) or code blocks (\`\`\`...\`\`\`).
3. Preserve all formatting markers in their original positions.
4. Return ONLY the translated text with preserved Markdown.`;

/**
 * Base class for Translation Providers
 */
class TranslationProvider {
  constructor(config, customPrompt = "") {
    this.config = config;
    this.customPrompt = customPrompt;
  }

  /**
   * Build the complete system prompt with custom additions
   */
  buildSystemPrompt(sourceLang, targetLang) {
    const basePrompt = DEFAULT_SYSTEM_PROMPT
      .replace("{sourceLang}", sourceLang)
      .replace("{targetLang}", targetLang);
    
    if (this.customPrompt && this.customPrompt.trim()) {
      return `${basePrompt}\n\nAdditional context: ${this.customPrompt.trim()}`;
    }
    
    return basePrompt;
  }

  async translate(text, sourceLang, targetLang) {
    throw new Error("Not implemented");
  }
}

/**
 * Chrome Built-in AI Provider
 */
class WindowAIProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    // This delegates to the offscreen document via background script
    // We return a special signal or handle it differently if needed.
    // However, since this runs in background, we can just use the existing flow
    // or we can move the offscreen logic here if we want to unify it.
    // For now, let's keep the offscreen logic separate but invoked by this provider.
    
    // Actually, the background script handles the offscreen messaging.
    // So this provider might just be a wrapper that says "use offscreen".
    return { useOffscreen: true };
  }
}

/**
 * Google Gemini Provider
 */
class GeminiProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "gemini-pro";
    
    if (!apiKey) throw new Error("Gemini API Key is missing");

    const systemPrompt = this.buildSystemPrompt(sourceLang, targetLang);
    const prompt = `${systemPrompt}\n\nText: ${text}`;
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "Gemini API Error");
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  }
}

/**
 * OpenAI Provider
 */
class OpenAIProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "gpt-3.5-turbo";
    const baseUrl = this.config.baseUrl || "https://api.openai.com/v1";
    
    if (!apiKey) throw new Error("OpenAI API Key is missing");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: this.buildSystemPrompt(sourceLang, targetLang) },
          { role: "user", content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "OpenAI API Error");
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
  }
}

/**
 * DeepL Provider
 */
class DeepLProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const apiKey = this.config.apiKey;
    const isFree = !apiKey.endsWith(":fx"); // Rough check, but DeepL usually distinguishes via domain
    // Actually DeepL API domain depends on plan: api-free.deepl.com vs api.deepl.com
    // But usually keys ending in :fx are free.
    const domain = apiKey.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
    
    if (!apiKey) throw new Error("DeepL API Key is missing");

    const params = new URLSearchParams();
    params.append("text", text);
    params.append("source_lang", sourceLang.toUpperCase());
    params.append("target_lang", targetLang.toUpperCase());
    
    const response = await fetch(`https://${domain}/v2/translate`, {
      method: "POST",
      headers: {
        "Authorization": `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    if (!response.ok) {
      throw new Error("DeepL API Error: " + response.statusText);
    }

    const data = await response.json();
    return data.translations?.[0]?.text;
  }
}

/**
 * Google Translate Provider (Free, no API key required)
 *
 * Robust endpoint chain: if one endpoint rate-limits (429) or fails, the next
 * one is tried automatically. Long texts are sent via POST body to avoid URL
 * length limits, and very long texts are chunked at sentence boundaries.
 * Every call reports the detected source language so callers can flip
 * direction when the typed text is already in the target language.
 */
const GT_ENDPOINTS = [
  // Classic endpoint (dj=1 gives sentences + src); POST body keeps long text safe
  {
    url: "https://translate.googleapis.com/translate_a/single",
    style: "json",
    auto: true
  },
  // Chrome-dictionary pool; separate rate limit, same JSON shape (no sl=auto)
  {
    url: "https://clients5.google.com/translate_a/single",
    style: "json",
    auto: false
  },
  // Chrome Translate extension endpoint; compact array format, real detection
  {
    url: "https://clients5.google.com/translate_a/t",
    style: "dict",
    auto: true
  }
];

const GT_TIMEOUT_MS = 12000;
const GT_MAX_CHUNK = 2800;
// Bounded parallelism for multi-chunk texts. Sequential chunk translation was
// the dominant latency cost for long texts (4 chunks = 4x); higher values
// than 2 risk Google Translate 429 rate limiting.
const GT_CONCURRENCY = 2;
// Detection-only probe: short timeout, small text sample (detection does not
// need the full text, just a representative prefix).
const GT_DETECT_TIMEOUT_MS = 5000;
const GT_DETECT_SAMPLE = 1000;

function gtSplitChunks(text) {
  if (text.length <= GT_MAX_CHUNK) return [text];

  const chunks = [];
  // Prefer paragraph -> sentence -> word boundaries
  const parts = text.split(/\n{2,}/);
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  const appendChunk = (part) => {
    if (part.length > GT_MAX_CHUNK) {
      // Hard-split oversized paragraph by sentences, then words
      const sentences = part.split(/(?<=[.!?。！？])\s+/);
      for (const sentence of sentences) {
        if (sentence.length > GT_MAX_CHUNK) {
          const words = sentence.split(/\s+/);
          for (const word of words) {
            if ((current + " " + word).trim().length > GT_MAX_CHUNK) pushCurrent();
            current = current ? `${current} ${word}` : word;
          }
        } else if ((current + " " + sentence).trim().length > GT_MAX_CHUNK) {
          pushCurrent();
          current = sentence;
        } else {
          current = current ? `${current} ${sentence}` : sentence;
        }
      }
    } else if ((current + "\n\n" + part).trim().length > GT_MAX_CHUNK) {
      pushCurrent();
      current = part;
    } else {
      current = current ? `${current}\n\n${part}` : part;
    }
  };

  for (const part of parts) appendChunk(part);
  pushCurrent();
  return chunks.length ? chunks : [text];
}

/**
 * Map `fn` over `items` with at most `limit` calls in flight. The returned
 * array preserves the input order regardless of completion order.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const workerCount = Math.max(0, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

class GoogleTranslateProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const sl = sourceLang === "auto" ? "auto" : sourceLang.toLowerCase();
    const tl = targetLang.toLowerCase();

    if (!text || !text.trim()) return { translation: "", detectedSource: sl };

    const chunks = gtSplitChunks(text);
    let detectedSource = sl !== "auto" ? sl : null;

    // Translate chunks with bounded concurrency (GT_CONCURRENCY). Chunks run
    // through the same per-chunk endpoint chain / retry logic as before;
    // mapWithConcurrency keeps results in chunk order. Per-chunk retries and
    // endpoint fallbacks are unchanged.
    const chunkResults = await mapWithConcurrency(chunks, GT_CONCURRENCY, (chunk) =>
      this.translateChunk(chunk, sl, tl)
    );

    const translations = [];
    for (const chunkResult of chunkResults) {
      translations.push(chunkResult.translation);
      if (chunkResult.detectedSource) detectedSource = chunkResult.detectedSource;
    }

    // Preserve paragraph breaks when the source had them; otherwise the text
    // was hard-split mid-paragraph and belongs on one flow.
    const joiner = text.includes("\n\n") ? "\n\n" : " ";
    return { translation: translations.join(joiner), detectedSource: detectedSource || "auto" };
  }

  async translateChunk(text, sl, tl) {
    let lastError = null;

    const endpoints = GT_ENDPOINTS.filter((e) => sl !== "auto" || e.auto !== false);

    for (const endpoint of endpoints) {
      // Retry transient failures (429/5xx/network) once per endpoint
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.callEndpoint(endpoint, sl, tl, text);
        } catch (err) {
          lastError = err;
          if (!err.isRetryable || attempt === 1) break;
          await new Promise((r) => setTimeout(r, 700));
        }
      }
    }

    throw lastError || new Error("Google Translate is unavailable");
  }

  /**
   * Detection-only probe: the dict-chrome-ex /t endpoint with sl=auto returns
   * the detected source language alongside the translation (same response
   * shape parsed in callEndpoint's dict branch). Only a short text sample is
   * sent. Never throws — callers fall back to the requested direction on
   * { ok: false }.
   */
  async detect(text) {
    try {
      const source = typeof text === "string" ? text : "";
      const sample = source.length > GT_DETECT_SAMPLE ? source.slice(0, GT_DETECT_SAMPLE) : source;
      if (!sample.trim()) return { ok: false };

      const params = new URLSearchParams();
      params.set("client", "dict-chrome-ex");
      params.set("sl", "auto");
      params.set("tl", "en");
      params.set("q", sample);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GT_DETECT_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`https://clients5.google.com/translate_a/t?${params.toString()}`, {
          method: "GET",
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) return { ok: false };

      // dict style with sl=auto: [["translation","detected_src"],...]
      const data = await response.json();
      const entry = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : null;
      const detected = entry && typeof entry[1] === "string" ? entry[1] : null;
      return detected ? { ok: true, detected } : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  async callEndpoint(endpoint, sl, tl, text) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GT_TIMEOUT_MS);

    try {
      let response;

      if (endpoint.style === "dict") {
        const params = new URLSearchParams();
        params.set("client", "dict-chrome-ex");
        params.set("sl", sl);
        params.set("tl", tl);
        params.set("q", text);
        response = await fetch(`${endpoint.url}?${params.toString()}`, {
          method: "GET",
          signal: controller.signal
        });
      } else {
        // POST body avoids URL length limits on long texts
        const clientParam = endpoint.url.includes("translate.googleapis.com") ? "gtx" : "android";
        response = await fetch(endpoint.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: `client=${clientParam}&dt=t&dj=1&sl=${sl}&tl=${tl}&q=${encodeURIComponent(text)}`,
          signal: controller.signal
        });
      }

      if (response.status === 429 || response.status >= 500) {
        const err = new Error(`Google Translate HTTP ${response.status}`);
        err.isRetryable = true;
        throw err;
      }

      if (!response.ok) {
        throw new Error(`Google Translate API Error: ${response.status} ${response.statusText}`);
      }

      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        const err = new Error("Invalid response from Google Translate");
        err.isRetryable = true;
        throw err;
      }

      if (endpoint.style === "dict") {
        // Format: [["translation","detected_src"],...] or [["translation"]] when sl fixed
        const entry = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : null;
        if (!entry || typeof entry[0] !== "string") {
          throw new Error("Invalid dict response from Google Translate");
        }
        return {
          translation: entry[0],
          detectedSource: typeof entry[1] === "string" ? entry[1] : null
        };
      }

      // json style: { sentences: [{trans, orig}], src }
      if (!data || !Array.isArray(data.sentences)) {
        const err = new Error("Invalid response from Google Translate");
        err.isRetryable = true;
        throw err;
      }

      const translation = data.sentences
        .map((sentence) => sentence.trans)
        .filter(Boolean)
        .join("");

      return {
        translation,
        detectedSource: typeof data.src === "string" ? data.src : null
      };
    } catch (err) {
      if (err.name === "AbortError") {
        const timeoutErr = new Error("Google Translate request timed out");
        timeoutErr.isRetryable = true;
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Microsoft Translate Provider (Bing) - DISABLED: Requires Authorization
 * Keeping code commented for future reference if auth method is found
 */
// class MicrosoftTranslateProvider extends TranslationProvider {
//   async translate(text, sourceLang, targetLang) {
//     // Microsoft Translate uses ISO 639-1 codes
//     // For auto-detect, leave 'from' parameter empty
//     const from = sourceLang === 'auto' ? '' : sourceLang.toLowerCase();
//     const to = targetLang.toLowerCase();
//     
//     const url = `https://api-edge.cognitive.microsofttranslator.com/translate?from=${from}&to=${to}&api-version=3.0`;
//     
//     // Microsoft Translate expects an array of text objects
//     const requestBody = [{ Text: text }];
//     
//     const response = await fetch(url, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json"
//       },
//       body: JSON.stringify(requestBody)
//     });
//
//     if (!response.ok) {
//       throw new Error("Microsoft Translate API Error: " + response.statusText);
//     }
//
//     const data = await response.json();
//     
//     // Parse the response
//     // Response is an array where each item has "translations" array
//     if (!Array.isArray(data) || data.length === 0) {
//       throw new Error("Invalid response from Microsoft Translate");
//     }
//     
//     // Extract the translation from the first item
//     const translationItem = data[0];
//     if (!translationItem.translations || translationItem.translations.length === 0) {
//       throw new Error("No translation found in Microsoft Translate response");
//     }
//     
//     return translationItem.translations[0].text;
//   }
// }

/**
 * OpenRouter Provider
 */
class OpenRouterProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "google/gemini-2.0-flash-exp:free";
    const baseUrl = "https://openrouter.ai/api/v1";
    
    if (!apiKey) throw new Error("OpenRouter API Key is missing");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://github.com/fernnguyen/transkit", // Required by OpenRouter
        "X-Title": "TransKit Extension" // Optional
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: this.buildSystemPrompt(sourceLang, targetLang) },
          { role: "user", content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "OpenRouter API Error");
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
  }
}

/**
 * Groq Provider (Fast inference API)
 */
class GroqProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "llama-3.3-70b-versatile";
    const baseUrl = "https://api.groq.com/openai/v1";
    
    if (!apiKey) throw new Error("Groq API Key is missing");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: this.buildSystemPrompt(sourceLang, targetLang) },
          { role: "user", content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "Groq API Error");
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim();
  }
}

/**
 * Custom Provider for OpenAI-compatible endpoints (Ollama, LM Studio, etc.)
 */
class CustomProvider extends TranslationProvider {
  async translate(text, sourceLang, targetLang) {
    const apiKey = this.config.apiKey;
    const model = this.config.model || "llama2";
    const baseUrl = this.config.baseUrl || "http://localhost:11434/v1";
    
    if (!baseUrl) throw new Error("Base URL is required for Custom provider");

    const headers = {
      "Content-Type": "application/json"
    };
    
    // Add Authorization header only if API key is provided
    if (apiKey && apiKey.trim()) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      console.log(`[CustomProvider] Calling ${baseUrl}/chat/completions with model: ${model}`);
      
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: this.buildSystemPrompt(sourceLang, targetLang) },
            { role: "user", content: text }
          ]
        })
      });

      console.log(`[CustomProvider] Response status: ${response.status}`);

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const errorMsg = err.error?.message || response.statusText;
        console.error(`[CustomProvider] API Error:`, err);
        throw new Error(`${errorMsg} (Status: ${response.status})`);
      }

      const data = await response.json();
      console.log(`[CustomProvider] Success:`, data);
      return data.choices?.[0]?.message?.content?.trim();
    } catch (error) {
      console.error(`[CustomProvider] Fetch Error:`, error);
      // Check if it's a network/CORS error
      if (error.message.includes('Failed to fetch') || error instanceof TypeError) {
        throw new Error(`Cannot connect to ${baseUrl}. Make sure:\n1. Ollama is running\n2. CORS is enabled\n3. URL is correct`);
      }
      throw error;
    }
  }
}

export class AIProviderService {
  constructor(settings) {
    this.settings = settings;
    this.activeProviderId = settings.activeProviderId || "builtin";
    this.providers = settings.providers || [];
    this.customPrompt = settings.customPrompt || "";
    
    this.activeProvider = this.providers.find(p => p.id === this.activeProviderId) || 
                          this.providers.find(p => p.id === "builtin") ||
                          { type: "gemini-nano", config: {} };
  }

  getProvider(providerId) {
    let providerData = this.activeProvider;
    
    if (providerId) {
      providerData = this.providers.find(p => p.id === providerId) || this.activeProvider;
    }

    const { type, config } = providerData;
    
    switch (type) {
      case "gemini":
        return new GeminiProvider(config, this.customPrompt);
      case "openai":
        return new OpenAIProvider(config, this.customPrompt);
      case "openrouter":
        return new OpenRouterProvider(config, this.customPrompt);
      case "deepl":
        return new DeepLProvider(config, this.customPrompt);
      case "google-translate":
        return new GoogleTranslateProvider(config, this.customPrompt);
      // case "microsoft-translate":
      //   return new MicrosoftTranslateProvider(config, this.customPrompt);
      case "groq":
        return new GroqProvider(config, this.customPrompt);
      case "ollama":
        return new CustomProvider(config, this.customPrompt);
      case "custom":
        return new CustomProvider(config, this.customPrompt);
      case "gemini-nano":
      default:
        return new WindowAIProvider({});
    }
  }

  /**
   * Detection-only probe for providers that support it (currently
   * google-translate, via its dict-chrome-ex endpoint). Returns
   * { ok, detected? } and never throws.
   */
  async detect(text, providerId) {
    try {
      const provider = this.getProvider(providerId);
      if (provider && typeof provider.detect === "function") {
        return await provider.detect(text);
      }
    } catch {}
    return { ok: false };
  }

  async translate(text, sourceLang, targetLang, providerId) {
    const provider = this.getProvider(providerId);
    const rawResult = await provider.translate(text, sourceLang, targetLang);

    // If it's the special offscreen signal, return it directly
    if (rawResult && typeof rawResult === 'object' && rawResult.useOffscreen) {
      return rawResult;
    }

    // Providers may return a plain string or { translation, detectedSource }
    const translation = typeof rawResult === 'object' && rawResult !== null
      ? rawResult.translation
      : rawResult;
    const detectedSource = typeof rawResult === 'object' && rawResult !== null
      ? rawResult.detectedSource
      : null;

    // Find the actual provider used for metadata
    const providerData = providerId
      ? (this.providers.find(p => p.id === providerId) || this.activeProvider)
      : this.activeProvider;

    return {
      translation,
      detectedSource: detectedSource || null,
      providerName: providerData.name,
      providerType: providerData.type
    };
  }
}
