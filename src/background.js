import { AIProviderService } from "./services/ai-providers.js";
import { htmlToMarkdown, markdownToHtml, shouldConvertFormat } from "./services/format-utils.js";

const OFFSCREEN_URL = chrome.runtime.getURL("pages/offscreen.html");
const SETTINGS_KEY = "translatorSettings";

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  const hasOffscreen = contexts.some(
    (c) =>
      c.contextType === "OFFSCREEN_DOCUMENT" && c.documentUrl === OFFSCREEN_URL
  );

  if (!hasOffscreen) {
    await chrome.offscreen.createDocument({
      url: "pages/offscreen.html",
      reasons: ["IFRAME_SCRIPTING"],
      justification:
        "Use built-in Translator and LanguageDetector APIs in a windowed context."
    });

    // Wait until offscreen is ready to accept messages
    for (let i = 0; i < 20; i++) {
      try {
        const pingRes = await chrome.runtime.sendMessage({ target: "offscreen", type: "offscreen-ping" });
        if (pingRes?.ok) break;
      } catch (e) {
        // Not ready yet, wait brief tick
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }
}

const DEFAULT_SETTINGS = {
  enabled: true,
  nativeLanguageCode: "vi",
  targetLanguageCode: "en",
  useAutoDetect: false, // Default to fixed direction (Target→Native)
  showConfirmModal: true,
  dialogTimeout: 10,
  aliases: {
    e: "en",
    v: "vi",
    ch: "zh",
    j: "ja"
  },
  interfaceLanguage: "en",
  // Instant translate settings.
  // ALL-SITES model: instant works on every website by default; the domain
  // list is an opt-OUT (exclusions), never a whitelist.
  instantTranslateEnabled: true,
  instantDelay: 300,
  instantPosition: "auto",
  instantExcludedDomains: [],
  migratedAllSites: true,
  allowGoogleFallback: false,
  // AI Provider settings — local on-device Nano is the default; no API keys
  activeProviderId: "builtin",
  providers: [
    {
      id: "google-translate",
      type: "google-translate",
      name: "Google Translate",
      config: {}
    },
    {
      id: "builtin",
      type: "gemini-nano",
      name: "Chrome Built-in AI",
      config: {}
    }
  ],
  // Keyboard shortcut for toggle instant domain
  instantToggleShortcut: {
    key: "I",
    ctrl: true,
    shift: true,
    alt: false
  },
  // Hover to Translate settings
  hoverTranslateEnabled: false,
  hoverTranslateMode: "inject", // "inject" or "replace"
  hoverTranslateDomains: [],
  hoverModifierKey: "ctrl", // "ctrl", "shift", "alt"
  hoverToggleShortcut: {
    key: "O",
    ctrl: true,
    shift: true,
    alt: false
  },
  // Style customization for hover inject mode
  hoverInjectStyle: {
    backgroundColor: "#667eea",
    textColor: "#0c69e4",
    fontSize: "0.95em",
    showIcon: true,
    underline: false
  },
  // Last used languages in Selection Popup
  selectionLastSource: null,
  selectionLastTarget: null
};

function mergeProviders(existingProviders) {
  const defaultProviders = DEFAULT_SETTINGS.providers;
  if (!Array.isArray(existingProviders) || existingProviders.length === 0) {
    return defaultProviders;
  }

  // Preserve all existing providers (user's custom providers and their configs)
  const merged = [...existingProviders];

  // Make sure default providers ('builtin' and 'google-translate') exist without overwriting
  for (const defP of defaultProviders) {
    if (!merged.some(p => p.id === defP.id)) {
      merged.push(defP);
    }
  }

  return merged;
}

async function readSettings() {
  try {
    const { [SETTINGS_KEY]: storedSettings } = await chrome.storage.local.get(SETTINGS_KEY);
    if (!storedSettings) {
      return DEFAULT_SETTINGS;
    }

    const merged = {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      providers: mergeProviders(storedSettings.providers),
      activeProviderId: storedSettings.activeProviderId || DEFAULT_SETTINGS.activeProviderId
    };

    // One-time migration from the old per-domain whitelist model to the
    // all-sites model: enable instant everywhere, switch to the local
    // built-in Nano provider (no API, no network), fast delay.
    if (!storedSettings.migratedAllSites) {
      merged.instantTranslateEnabled = true;
      merged.instantDelay = (!storedSettings.instantDelay || storedSettings.instantDelay === 3000)
        ? DEFAULT_SETTINGS.instantDelay
        : storedSettings.instantDelay;
      merged.instantPosition = "auto";
      merged.instantExcludedDomains = [];
      merged.activeProviderId = "builtin";
      merged.migratedAllSites = true;
      await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    }

    return merged;
  } catch (err) {
    console.error("TransKit background: readSettings error:", err);
    return DEFAULT_SETTINGS;
  }
}

async function writeSettings(next) {
  try {
    const current = await readSettings();
    const merged = {
      ...current,
      ...next
    };
    if (next && Array.isArray(next.providers)) {
      merged.providers = mergeProviders(next.providers);
    }
    if (next && next.activeProviderId) {
      merged.activeProviderId = next.activeProviderId;
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    return merged;
  } catch (err) {
    console.error("TransKit background: writeSettings error:", err);
    throw err;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const s = await readSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  } catch (err) {
    console.error("TransKit background: onInstalled error:", err);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // If message is targeted to offscreen document, ignore in background to avoid early port closure
  if (message?.target === "offscreen") {
    return;
  }
  if (message?.type === "ping") {
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "get-settings") {
    readSettings()
      .then((s) => sendResponse({ ok: true, settings: s }))
      .catch((err) => {
        console.error("TransKit background: get-settings error:", err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (message?.type === "set-settings") {
    writeSettings(message.settings)
      .then((s) => sendResponse({ ok: true, settings: s }))
      .catch((err) => {
        console.error("TransKit background: set-settings error:", err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (message?.type === "translate") {
    (async () => {
      try {
        const settings = await readSettings();
        // Extract payload using keys sent by content-script.js
        const { text, nativeLanguageCode, targetLanguage, sourceLanguage, providerId } = message.payload || {};

        // Map to standardized keys for AIProviderService
        // Use 'auto' if sourceLanguage is not explicitly provided
        const sourceLang = sourceLanguage || "auto";
        const targetLang = targetLanguage;

        // Deterministic test mode: exercises the whole DOM/pipeline stack
        // (segmentation, apply engine, popups) without any network dependency.
        if (settings.testEchoMode) {
          const echoed = String(text || "")
            .split(/\n{2,}/)
            .map((p) => "ECHO:" + p.trim())
            .join("\n\n");
          sendResponse({
            ok: true,
            result: {
              translation: echoed,
              providerName: "Echo (test)",
              providerType: "echo",
              sourceLanguage: sourceLang,
              targetLanguage: targetLang
            }
          });
          return;
        }

        const aiService = new AIProviderService(settings);
        
        // Determine the provider type to use
        const activeProvider = providerId 
          ? settings.providers?.find(p => p.id === providerId)
          : settings.providers?.find(p => p.id === settings.activeProviderId);
        
        const providerType = activeProvider?.type || "gemini-nano";

        // --- Format Conversion Logic ---
        let textToTranslate = text;
        let hasFormatting = false;
        
        // Apply format conversion for all providers
        if (shouldConvertFormat(text)) {
          textToTranslate = htmlToMarkdown(text);
          hasFormatting = true;
        }
        
        const result = await aiService.translate(textToTranslate, sourceLang, targetLang, providerId);

        // Direction sanity check: when the typed text is already in the target
        // language, translating target->target is a no-op. Start detection
        // from 'auto' so the provider reports the true source, and flip the
        // direction towards the native language when needed. Generic language
        // logic, no per-site behavior.
        let finalResult = result;
        let finalTargetLang = targetLang;
        const wantsFlip = message.payload?.flipOnSameLanguage === true;
        const nativeCode = (message.payload?.nativeLanguageCode || "").toLowerCase();
        const nativeMain = nativeCode.split("-")[0];
        const targetCodeNorm = (targetLang || "").toLowerCase();
        const sourceCodeNorm = (sourceLang || "").toLowerCase();

        // Only re-request with auto when the caller forced the native source
        // (instant mode) — explicit !!lang commands keep their semantics.
        const shouldAutoDetectForFlip =
          wantsFlip && nativeMain && sourceCodeNorm === nativeMain && nativeMain !== targetCodeNorm;

        let effectiveResult = result;
        if (shouldAutoDetectForFlip && result && !result.useOffscreen) {
          try {
            effectiveResult = await aiService.translate(textToTranslate, "auto", targetLang, providerId);
          } catch (autoErr) {
            console.warn("TransKit background: auto-detect retry failed:", autoErr);
            effectiveResult = result;
          }
        }

        const detected = (effectiveResult?.detectedSource || "").toLowerCase().split("-")[0];
        const needsFlip = shouldAutoDetectForFlip && detected && detected !== nativeMain;

        if (needsFlip && detected === targetCodeNorm) {
          // Text is already in the target language -> translate to native
          try {
            const flipped = await aiService.translate(textToTranslate, detected, nativeCode, providerId);
            if (flipped?.useOffscreen || flipped?.translation) {
              finalResult = flipped;
              finalTargetLang = nativeCode;
            }
          } catch (flipErr) {
            console.warn("TransKit background: flip re-translate failed:", flipErr);
          }
        } else if (effectiveResult && effectiveResult !== result) {
          finalResult = effectiveResult;
        }

        // If result is the special signal for Window AI, use offscreen
        if (finalResult?.useOffscreen) {
          await ensureOffscreen();
          const offscreenPayload = { ...message.payload, text: textToTranslate, targetLanguage: finalTargetLang };
          if (shouldAutoDetectForFlip) {
            // Let the built-in detector decide the real source direction
            offscreenPayload.sourceLanguage = "auto";
            offscreenPayload.useAutoDetect = true;
          }
          const offscreenResult = await chrome.runtime.sendMessage({
            target: "offscreen",
            type: "offscreen-translate",
            payload: offscreenPayload
          });

          if (offscreenResult?.ok) {
            let translation = offscreenResult.translation;

            // Convert back to HTML if formatting was converted
            if (hasFormatting && translation) {
              translation = markdownToHtml(translation);
            }

            const resultObj = {
              translation: translation,
              sourceLanguage: offscreenResult.sourceLanguage,
              targetLanguage: offscreenResult.targetLanguage,
              providerName: offscreenResult.providerName || "Chrome Built-in AI",
              providerType: offscreenResult.providerType || "Built-in"
            };

            sendResponse({ ok: true, result: resultObj });
          } else {
            // Local-Nano-only policy: never silently switch engines. If the
            // on-device Translator API is missing (e.g. Linux Chrome builds),
            // surface the error; the user can enable the optional GT rescue
            // (allowGoogleFallback) or pick another provider themselves.
            const errText = String(offscreenResult?.error || "Unknown offscreen error");
            if (/not supported/i.test(errText) && settings.allowGoogleFallback === true) {
              console.warn("TransKit background: Translator API absent, using user-enabled google-translate fallback");
              const gtProvider = settings.providers?.find(p => p.type === "google-translate");
              const gtResult = await aiService.translate(textToTranslate, sourceLang, targetLang, gtProvider?.id);
              sendResponse({
                ok: true,
                result: {
                  translation: gtResult?.translation,
                  providerName: "Google Translate (fallback)",
                  providerType: "google-translate",
                  sourceLanguage: sourceLang,
                  targetLanguage: gtResult?.detectedSource === targetCodeNorm ? nativeCode : targetLang
                }
              });
            } else {
              const hint = /not supported/i.test(errText)
                ? errText + " (Bu cihazin Chrome'unda yerel Translator API yok.)"
                : errText;
              sendResponse({ ok: false, error: hint });
            }
          }
        } else {
          // Convert back to HTML if formatting was converted
          let translation = finalResult?.translation;
          if (hasFormatting && translation) {
            translation = markdownToHtml(translation);
          }

          // Result is the object { translation, providerName, providerType }
          sendResponse({
            ok: true,
            result: {
              translation: translation,
              providerName: finalResult?.providerName,
              providerType: finalResult?.providerType,
              sourceLanguage: sourceLang,
              targetLanguage: finalTargetLang
            }
          });
        }
      } catch (err) {
        console.error("TransKit background: Translation Error:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  }

  if (message?.type === "open-options") {
    try {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message });
    }
    return false;
  }

  if (message?.type === "tts-play") {
    (async () => {
      try {
        await ensureOffscreen();
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "play-tts",
          payload: message.payload
        });
        sendResponse({ ok: true });
      } catch (err) {
        console.error("TransKit background: TTS Error:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  return false;
});
