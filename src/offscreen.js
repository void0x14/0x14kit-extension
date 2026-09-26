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

  // Bidirectional check: finalSource and target cannot be the same (tr -> tr or en -> en).
  // If same, switch target to the opposite language (en or tr) before calling Translator.create
  if (finalSource === target) {
    if (target === "tr") {
      target = "en";
    } else if (target === "en") {
      target = "tr";
    } else {
      target = finalSource === "en" ? "tr" : "en";
    }
    if (finalSource === target) {
      finalSource = target === "en" ? "tr" : "en";
    }
  }

  const pairSource = finalSource;
  const availability = await getAvailabilityForPair(pairSource, target);

  if (availability === "unsupported")
    return {
      ok: false,
      error: `Language pair ${pairSource} -> ${target} is not supported by Chrome Built-in AI.`
    };

  try {
    const translator = await TranslatorAPI.create({
      sourceLanguage: pairSource,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener("downloadprogress", () => {});
      }
    });

    const translated = await translator.translate(text);

    return {
      ok: true,
      translation: translated,
      sourceLanguage: finalSource || "auto",
      targetLanguage: target
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e || "Translation failed")
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "offscreen-ping") {
    sendResponse({ ok: true });
    return false;
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
