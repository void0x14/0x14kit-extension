// Support both modern self.ai?.translator / self.translation and legacy self.Translator
function getTranslatorAPI() {
  if (typeof self !== "undefined") {
    if (self.ai?.translator) return self.ai.translator;
    if (self.translation) return self.translation;
    if (self.Translator) return self.Translator;
  }
  return null;
}

function getLanguageDetectorAPI() {
  if (typeof self !== "undefined") {
    if (self.ai?.languageDetector) return self.ai.languageDetector;
    if (self.LanguageDetector) return self.LanguageDetector;
  }
  return null;
}
import { normalizeLanguageToCode } from "./common/language-map.js";

let detector;

async function getAvailabilityForPair(sourceLanguage, targetLanguage) {
  const TranslatorAPI = getTranslatorAPI();
  if (!TranslatorAPI) return "unsupported";

  try {
    const status = await TranslatorAPI.availability({
      sourceLanguage,
      targetLanguage
    });
    return status;
  } catch {
    return "unsupported";
  }
}

async function ensureDetector() {
  const DetectorAPI = getLanguageDetectorAPI();
  if (!DetectorAPI) return null;

  if (detector) return detector;

  try {
    const DetectorAPI = getLanguageDetectorAPI();
    if (!DetectorAPI) return null;
    const availability = await DetectorAPI.availability();

    if (availability === "downloadable" || availability === "after-download") {
      detector = await DetectorAPI.create({
        monitor(m) {
          m.addEventListener("downloadprogress", () => {});
        }
      });

      return detector;
    }

    if (availability === "available") {
      detector = await DetectorAPI.create();
      return detector;
    }
  } catch {}

  return null;
}

async function detectLanguage(text) {
  const d = await ensureDetector();

  if (!d) return null;

  try {
    const results = await d.detect(text);

    if (Array.isArray(results) && results.length > 0) {
      return results[0].detectedLanguage;
    }
  } catch {}

  return null;
}

async function runTranslation(
  text,
  requestedSource,
  requestedTarget,
  useAutoDetect
) {
  let target = normalizeLanguageToCode(requestedTarget);

  if (!target) return { ok: false, error: "Invalid target language" };

  let source = normalizeLanguageToCode(requestedSource);
  if (!source) source = null;

  const TranslatorAPI = getTranslatorAPI();
  if (!TranslatorAPI)
    return { ok: false, error: "Translator API not supported" };

  let finalSource = source;

  if (!finalSource || finalSource === "auto" || finalSource === target) {
    const detected = await detectLanguage(text);
    if (detected && detected !== target) {
      finalSource = detected;
    } else if (detected) {
      finalSource = detected;
    } else if (finalSource === target) {
      finalSource = null;
    }
  }

  // Fallback: If language detection fails / unavailable, do not crash!
  if (!finalSource || finalSource === "auto") {
    const normTarget = normalizeLanguageToCode(target || requestedTarget);
    if (normTarget === "tr") {
      finalSource = "en";
    } else if (normTarget === "en") {
      finalSource = "tr";
    } else {
      finalSource = normTarget === "en" ? "tr" : "en";
    }
  }

  // Candidate sources, in order: detected language, requested source,
  // heuristic fallback. Chrome's Translator rejects unsupported codes at
  // create() — so every candidate is availability-checked first and a
  // rejected one never aborts the request (the next candidate runs).
  const sanitize = (code) => {
    if (!code) return null;
    const c = String(code).toLowerCase();
    if (c.startsWith("zh")) {
      if (c.includes("tw") || c.includes("hant")) return "zh-TW";
      return "zh";
    }
    return c.split("-")[0];
  };

  const normTarget = target;
  const requested = sanitize(source);
  const detectedSan = sanitize(finalSource && finalSource !== "auto" ? finalSource : null);

  const candidates = [];
  const addCandidate = (c) => {
    if (!c || c === normTarget) return;
    if (!candidates.includes(c)) candidates.push(c);
  };
  addCandidate(detectedSan);
  addCandidate(requested);
  addCandidate(normTarget === "tr" ? "en" : normTarget === "en" ? "tr" : null);

  if (candidates.length === 0) {
    // Text is (probably) already in the target language: flip the direction
    // so the user still gets a useful translation.
    const flipped = normTarget === "tr" ? "en" : "en";
    addCandidate(flipped === normTarget ? "tr" : flipped);
  }

  const TranslatorAPI2 = TranslatorAPI;
  let lastError = null;

  for (const pairSource of candidates) {
    const availability = await getAvailabilityForPair(pairSource, normTarget);
    if (availability === "unsupported") continue;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500));
          const retryAvail = await getAvailabilityForPair(pairSource, normTarget);
          if (retryAvail === "unsupported") break;
        }
        const translator = await TranslatorAPI2.create({
          sourceLanguage: pairSource,
          targetLanguage: normTarget,
          monitor(m) {
            m.addEventListener("downloadprogress", () => {});
          }
        });
        const translated = await translator.translate(text);
        return {
          ok: true,
          translation: translated,
          sourceLanguage: pairSource,
          targetLanguage: normTarget
        };
      } catch (e) {
        lastError = e;
      }
    }
  }

  const pairText = candidates.length
    ? `${candidates.join(", ")} -> ${normTarget}`
    : `? -> ${normTarget}`;
  return {
    ok: false,
    error: `Chrome yerel cevirisi bu dil ciftini desteklemiyor (${pairText}).`
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "offscreen-ping") {
    sendResponse({ ok: true });
    return false;
  }

  // Detection-only probe so the background can decide the translation
  // direction BEFORE issuing its single translation pass.
  if (message?.type === "offscreen-detect") {
    const text = String(message.payload?.text || "");
    if (!text.trim()) {
      sendResponse({ ok: false });
      return false;
    }
    detectLanguage(text)
      .then((detected) =>
        sendResponse(detected ? { ok: true, detected } : { ok: false })
      )
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "offscreen-translate") {
    const { text, nativeLanguageCode, targetLanguage, useAutoDetect, sourceLanguage } =
      message.payload || {};

    // If sourceLanguage is 'auto', we want detection. 
    // If it's a specific code, use it.
    // If useAutoDetect=true, use null for auto-detection.
    // If useAutoDetect=false, use nativeLanguageCode for fixed direction.
    let requestedSource = (sourceLanguage && sourceLanguage !== 'auto') 
      ? sourceLanguage 
      : (useAutoDetect ? null : nativeLanguageCode);

    // If requestedSource and targetLanguage are identical, avoid crash by falling back or inverting
    if (requestedSource && targetLanguage && normalizeLanguageToCode(requestedSource) === normalizeLanguageToCode(targetLanguage)) {
      if (message.payload?.targetLanguageCode && normalizeLanguageToCode(message.payload.targetLanguageCode) !== normalizeLanguageToCode(targetLanguage)) {
        requestedSource = message.payload.targetLanguageCode;
      } else {
        requestedSource = null; // Fallback to auto-detection
      }
    }

    runTranslation(
      text,
      requestedSource,
      targetLanguage,
      useAutoDetect
    )
      .then((r) => sendResponse(r))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message || err) })
      );

    return true;
  }

  if (message?.type === "play-tts") {
    const { text, lang, speed, urlTemplate } = message.payload;
    playTTS(text, lang, speed, urlTemplate)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});

async function playTTS(text, lang, speed = 1, urlTemplate = null) {
  let url;
  
  if (urlTemplate) {
    // Replace variables
    url = urlTemplate
      .replace('{text}', encodeURIComponent(text))
      .replace('{lang}', lang)
      .replace('{speed}', speed);
  } else {
    // Default fallback
    url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&ttsspeed=${speed}&q=${encodeURIComponent(text)}`;
  }
  
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = (e) => reject(new Error("Audio playback failed"));
    audio.play().catch(reject);
  });
}
