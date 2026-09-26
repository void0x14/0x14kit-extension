let normalizeLanguageToCode;
let i18n;
let tts;

const TRANSLATION_COMMAND_PATTERN = /!!([a-zA-ZÀ-ÿ\-]+)$/i;

// RAT-FIX: never append UI elements into an editable body (http editors such as
// SCEditor/CKEditor serialize body content into the post -> icons/text leaked
// into forum posts).
function btSafeRoot() {
  try {
    const b = document.body;
    if (b && (b.isContentEditable || document.designMode === "on")) return document.documentElement;
  } catch (e) {}
  return document.body || document.documentElement;
}

let isTranslating = false;
let translatingTimeout = null;
let lastAppliedText = "";
let lastAppliedAt = 0;
let debounceTimer = null;

// Helper function to check if extension context is valid
function isExtensionContextValid() {
  try {
    return !!(typeof chrome !== "undefined" && chrome?.runtime?.id);
  } catch (e) {
    return false;
  }
}

// Robust message sender with retry for Service Worker wake-up
async function sendMessageWithRetry(message, maxRetries = 2, delayMs = 150) {
  if (!isExtensionContextValid()) {
    const err = new Error('Extension context invalidated');
    err.isContextInvalidated = true;
    throw err;
  }

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!isExtensionContextValid()) {
      const err = new Error('Extension context invalidated');
      err.isContextInvalidated = true;
      throw err;
    }

    try {
      const response = await new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage(message, (res) => {
            const runtimeErr = chrome.runtime.lastError;
            if (runtimeErr) {
              reject(new Error(runtimeErr.message || String(runtimeErr)));
            } else {
              resolve(res);
            }
          });
        } catch (syncErr) {
          reject(syncErr);
        }
      });
      return response;
    } catch (err) {
      lastError = err;
      const msg = err?.message || "";
      const isContextErr = msg.includes("Extension context invalidated") || !isExtensionContextValid();

      if (isContextErr) {
        cleanupExtensionElements();
        const invalidErr = new Error("Extension context invalidated");
        invalidErr.isContextInvalidated = true;
        throw invalidErr;
      }

      const isConnectionErr = 
        msg.includes("Could not establish connection") || 
        msg.includes("receiving end does not exist") ||
        msg.includes("The message port closed before a response was received");

      // Transient wake-up error: retry if attempts remaining
      if (isConnectionErr && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }

      break;
    }
  }

  throw lastError;
}

// Instant translate state
let instantTimer = null;
let currentSuggestion = null;
let justAppliedTranslation = false;
let currentKeyHandler = null; // Track active keyboard handler
let isIMEComposing = false; // Track if IME composition is active

// Select-to-translate state
let selectionIcon = null;
let selectionPopup = null;
let selectedText = "";

const commonStyles = {
  fontFamily: "system-ui, sans-serif",
  background: "#FFFF",
  color: "#1C2024",
  borderRadius: "0.375rem",
  boxShadow: "0 .375rem 1.5rem #0000000f",
  zIndex: "9999999999"
};

// Global error handler for extension context invalidation
window.addEventListener('error', (event) => {
  if (event.error && event.error.message && 
      event.error.message.includes('Extension context invalidated')) {
    console.info('TransKit: Extension context invalidated, detaching cleanly');
    cleanupExtensionElements();
    event.preventDefault();
  }
});

// Global unhandled promise rejection handler
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && event.reason.message && 
      event.reason.message.includes('Extension context invalidated')) {
    console.info('TransKit: Extension context invalidated, detaching cleanly');
    cleanupExtensionElements();
    event.preventDefault();
  }
});

(async function bootstrap() {
  try {
    if (!isExtensionContextValid()) {
      console.log('TransKit: Extension context not available during bootstrap');
      return;
    }

    // Wrap all chrome.runtime calls in try-catch
    let mod, i18nMod, ttsMod;
    try {
      mod = await import(chrome.runtime.getURL("src/common/language-map.js"));
      normalizeLanguageToCode = mod.normalizeLanguageToCode;
      
      i18nMod = await import(chrome.runtime.getURL("src/common/i18n.js"));
      i18n = i18nMod.i18n;

      ttsMod = await import(chrome.runtime.getURL("src/services/tts.js"));
      tts = ttsMod.tts;
    } catch (importError) {
      if (importError.message.includes('Extension context invalidated') || 
          importError.message.includes('Could not establish connection')) {
        console.log('TransKit: Extension context invalidated during import');
        cleanupExtensionElements();
        return;
      }
      throw importError;
    }
    
    // Initialize i18n with current settings
    getSettings().then(settings => {
      if (settings.interfaceLanguage) {
        i18n.setLanguage(settings.interfaceLanguage);
      }
    }).catch(err => {
      console.log('TransKit: Error initializing i18n:', err.message);
    });

    // Listen for setting changes
    try {
      chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes.translatorSettings) {
          const newSettings = changes.translatorSettings.newValue;
          if (newSettings && newSettings.interfaceLanguage) {
            i18n.setLanguage(newSettings.interfaceLanguage);
          }
        }
      });
    } catch (storageError) {
      console.log('TransKit: Error setting up storage listener:', storageError.message);
    }
    
    registerAutoDetection();
    registerInstantMode();
    registerSelectionMode();
    registerInstantToggleShortcut();
    registerInstantLabelIndicator();
    registerHoverTranslate();
    registerHoverToggleShortcut();
  } catch (error) {
    console.log('TransKit: Bootstrap failed:', error.message);
    if (error.message.includes('Extension context invalidated') || 
        error.message.includes('Could not establish connection')) {
      // Extension was reloaded, clean up and exit gracefully
      cleanupExtensionElements();
    }
  }
})();

function isEditableElement(element) {
  if (!element) return false;

  const tag = element.tagName?.toLowerCase();

  if (tag === "input") {
    const type = element.getAttribute("type") || "text";
    return (
      ["text", "search", "email", "url", "tel", "password"].includes(type) ||
      !type
    );
  }

  if (tag === "textarea") return true;
  if (element.isContentEditable) return true;

  return false;
}

function getDeepActiveElement(root = document) {
  let element = root.activeElement || null;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  return element;
}

function getActiveEditableElement() {
  const element = getDeepActiveElement();
  return isEditableElement(element) ? element : null;
}

// Resolve the editable element that actually received an input event.
// composedPath() crosses open shadow roots, so this works on web-component
// heavy sites where document.activeElement is just the host element.
function resolveEditableFromEvent(event) {
  try {
    const path = typeof event?.composedPath === "function" ? event.composedPath() : null;
    if (path && path.length) {
      for (const node of path) {
        if (node && node.nodeType === Node.ELEMENT_NODE && isEditableElement(node)) {
          return node;
        }
      }
    }
  } catch (e) {}

  const target = event?.target;
  if (isEditableElement(target)) return target;

  return getActiveEditableElement();
}

function parseFieldTextAndCommand(element) {
  if (!element) return null;

  let value = "";
  const tag = element.tagName?.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    value = element.value;
  } else if (element.isContentEditable) {
    value = element.innerText;
  }

  const match = value.match(TRANSLATION_COMMAND_PATTERN);
  if (!match) return null;

  const languageRaw = match[1];
  const precedingText = value.slice(0, match.index).trimEnd();
  return { text: precedingText, languageRaw };
}

function createOverlayShadowHost() {
  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.zIndex = commonStyles.zIndex;
  host.style.inset = "0";
  host.style.pointerEvents = "none"; // Ensure clicks pass through the host
  document.documentElement.appendChild(host);
  return host.attachShadow({ mode: "closed" });
}

function attachStylesheetToShadowRoot(shadowRoot) {
  const href = chrome.runtime.getURL("assets/styles/dialogs.css");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  shadowRoot.appendChild(link);
}



const DEFAULT_TRANSLATOR_SETTINGS = {
  enabled: true,
  nativeLanguageCode: "vi",
  targetLanguageCode: "en",
  useAutoDetect: false,
  showConfirmModal: true,
  dialogTimeout: 10,
  aliases: {
    e: "en",
    v: "vi",
    ch: "zh",
    j: "ja"
  },
  interfaceLanguage: "en",
  instantTranslateEnabled: true,
  instantDelay: 300,
  instantPosition: "auto",
  instantExcludedDomains: [],
  activeProviderId: "google-translate",
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
  hoverTranslateEnabled: false,
  hoverTranslateMode: "inject",
  hoverTranslateDomains: [],
  hoverModifierKey: "ctrl"
};

// Short-lived settings cache so per-keystroke listeners don't hammer storage.
let cachedSettings = null;
let cachedSettingsAt = 0;
const SETTINGS_CACHE_TTL = 3000;

try {
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes.translatorSettings) {
      cachedSettings = changes.translatorSettings.newValue || null;
      cachedSettingsAt = Date.now();
    }
  });
} catch (e) {}

function normalizeHostname(hostname) {
  return String(hostname || "").replace(/^www\./i, "").toLowerCase();
}

function hostMatchesPattern(hostname, pattern) {
  const host = normalizeHostname(hostname);
  const pat = normalizeHostname(String(pattern || "")).replace(/\/.*$/, "").trim();
  if (!host || !pat) return false;
  return host === pat || host.endsWith("." + pat);
}

// All-sites model: instant works everywhere unless the site was excluded.
function isInstantAllowed(settings) {
  if (!settings || settings.instantTranslateEnabled === false) return false;
  if (settings.enabled === false) return false;

  const host = window.location.hostname;
  const excluded = Array.isArray(settings.instantExcludedDomains)
    ? settings.instantExcludedDomains
    : [];

  return !excluded.some(
    (d) => d && d.enabled !== false && hostMatchesPattern(host, d.domain)
  );
}

async function getSettings() {
  if (!isExtensionContextValid()) {
    return DEFAULT_TRANSLATOR_SETTINGS;
  }

  // 0. Fresh cache (invalidated by storage.onChanged)
  if (cachedSettings && Date.now() - cachedSettingsAt < SETTINGS_CACHE_TTL) {
    return cachedSettings;
  }

  // 1. Direct storage.local access (storage permission is available in content script)
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const storageData = await chrome.storage.local.get("translatorSettings");
      if (storageData && storageData.translatorSettings) {
        const s = storageData.translatorSettings;
        cachedSettings = s;
        cachedSettingsAt = Date.now();
        if (i18n && typeof i18n.setLanguage === "function") {
          i18n.setLanguage(s.interfaceLanguage || "en");
        }
        return s;
      }
    }
  } catch (err) {
    // fallback to background message
  }

  // 2. Fallback to background query if storage read yielded nothing
  try {
    const res = await sendMessageWithRetry({ type: "get-settings" }, 1, 100);
    if (res?.ok && res.settings) {
      cachedSettings = res.settings;
      cachedSettingsAt = Date.now();
      if (i18n && typeof i18n.setLanguage === "function") {
        i18n.setLanguage(res.settings.interfaceLanguage || "en");
      }
      return res.settings;
    }
  } catch (error) {
    if (error?.isContextInvalidated || !isExtensionContextValid()) {
      cleanupExtensionElements();
    }
  }

  return DEFAULT_TRANSLATOR_SETTINGS;
}

async function requestTranslation(payload) {
  if (!isExtensionContextValid()) {
    cleanupExtensionElements();
    return { ok: false, contextInvalidated: true, error: "Extension context invalidated" };
  }
  
  try {
    const res = await sendMessageWithRetry({ type: "translate", payload }, 2, 150);
    return res;
  } catch (error) {
    if (error?.isContextInvalidated || !isExtensionContextValid() || error?.message?.includes("Extension context invalidated")) {
      cleanupExtensionElements();
      return { ok: false, contextInvalidated: true, error: "Extension context invalidated" };
    }
    
    let errorMsg = error?.message || "Translation service error";
    if (errorMsg.includes("Could not establish connection") || errorMsg.includes("receiving end does not exist") || errorMsg.includes("message port closed")) {
      errorMsg = "Çeviri servisine bağlanılamadı. Lütfen tekrar deneyin.";
    }
    throw new Error(errorMsg);
  }
}

function removeTranslationCommandSuffix(element) {
  if (!element) return "";

  let value = "";
  const tag = element.tagName?.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    value = element.value;
    value = value.replace(TRANSLATION_COMMAND_PATTERN, "").trimEnd();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      element.setSelectionRange(element.value.length, element.value.length);
    } catch (_) {
      try { element.selectionStart = element.selectionEnd = element.value.length; } catch (__) {}
    }
    return value;
  }

  if (element.isContentEditable) {
    value = element.innerText || element.textContent || "";
    value = value.replace(TRANSLATION_COMMAND_PATTERN, "").trimEnd();
    try {
      if (document.activeElement !== element) {
        element.focus();
      }
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(element);
        sel.removeAllRanges();
        sel.addRange(range);
        const ok = document.execCommand("insertText", false, value);
        if (!ok) element.textContent = value;
        const endRange = document.createRange();
        endRange.selectNodeContents(element);
        endRange.collapse(false);
        sel.removeAllRanges();
        sel.addRange(endRange);
        if (typeof sel.collapseToEnd === "function") {
          try { sel.collapseToEnd(); } catch (_) {}
        }
      } else {
        element.textContent = value;
      }
    } catch (e) {
      element.textContent = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return value;
  }

  return "";
}

let lastToastMessage = "";
let lastToastAt = 0;

function showToast(message) {
  // Extension context invalidation is normal lifecycle noise (extension
  // reload/update); clean up silently instead of alarming the user.
  if (String(message || "").includes("Extension context invalidated")) {
    console.info("TransKit: context invalidated; detaching silently");
    cleanupExtensionElements();
    return;
  }
  // Identical messages repeat fast when a site fires many input events;
  // showing them once per 4 seconds is enough.
  const now = Date.now();
  if (message === lastToastMessage && now - lastToastAt < 4000) return;
  lastToastMessage = message;
  lastToastAt = now;
  const host = document.createElement("div");
  const lowerMsg = message.toLowerCase();

  // Determine toast type and icon
  let icon = '•';
  let toastType = 'default'; // default, warning, success

  if (lowerMsg.includes('translating') || lowerMsg.includes('đang dịch')) {
    icon = '⏳';
    toastType = 'default';
  } else if (lowerMsg.includes('enabled') || lowerMsg.includes('đã bật')) {
    icon = '✓';
    toastType = 'success';
  } else if (lowerMsg.includes('disabled') || lowerMsg.includes('đã tắt')) {
    icon = '⚠️';
    toastType = 'warning';
  } else if (lowerMsg.includes('failed') || lowerMsg.includes('thất bại')) {
    icon = '⚠️';
    toastType = 'warning';
  } else if (lowerMsg.includes('updated') || lowerMsg.includes('cập nhật')) {
    icon = 'ℹ️';
    toastType = 'default';
  } else if (lowerMsg.includes('error') || lowerMsg.includes('lỗi')) {
    icon = '❌';
    toastType = 'warning';
  } else if (lowerMsg.includes('invalid') || lowerMsg.includes('không hợp lệ')) {
    icon = '⚠️';
    toastType = 'warning';
  } else if (lowerMsg.includes('instant')) {
    icon = '⚡';
    toastType = 'default';
  }

  // Set class based on type
  host.className = `bt-toast-notify bt-toast-notify-${toastType} bt-vars-container`;

  host.innerHTML = `
    <div class="bt-toast-notify-content">
      <span class="bt-toast-notify-icon">${icon}</span>
      <span class="bt-toast-notify-text">${message}</span>
    </div>
  `;
  document.documentElement.appendChild(host);

  // Fade out animation - close faster
  setTimeout(() => {
    host.classList.add('bt-toast-notify-exit');
    setTimeout(() => host.remove(), 300);
  }, 1500);
}

function registerAutoDetection() {
  document.addEventListener("input", handleUserInputEvent, true);
  document.addEventListener("blur", handleUserInputEvent, true);
}

function handleUserInputEvent() {
  if (!isExtensionContextValid()) return;
  const element = getActiveEditableElement();
  if (!element) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => attemptTranslationTrigger(element), 600);
}

function attemptTranslationTrigger(element) {
  if (!isExtensionContextValid()) return;
  if (isTranslating) return;
  const parsed = parseFieldTextAndCommand(element);
  if (!parsed) return;
  handleAutoTranslation(element, parsed);
}

function resolveTargetLanguage(raw, settings) {
  if (raw === "t") return settings.targetLanguageCode || "en";
  
  // Check aliases
  if (settings.aliases && settings.aliases[raw]) {
    return settings.aliases[raw];
  }

  // Fallback to normalization (e.g. "english" -> "en")
  return normalizeLanguageToCode(raw);
}

async function handleAutoTranslation(element, parsed) {
  if (!isExtensionContextValid()) return;
  isTranslating = true;
  if (translatingTimeout) clearTimeout(translatingTimeout);
  translatingTimeout = setTimeout(() => {
    isTranslating = false;
  }, 5000);
  let suggestion = null;

  try {
    const baseText = parsed.text;
    
    // Wrap getSettings to catch invalidation early
    let settings;
    try {
      settings = await getSettings();
    } catch (e) {
      return;
    }

    if (!isExtensionContextValid()) return;
    if (settings.enabled === false) return;

    const targetCode = resolveTargetLanguage(parsed.languageRaw, settings);

    if (!baseText || !baseText.trim()) return;
    if (!targetCode) {
      showToast(i18n.t("toast.invalidLanguage"));
      return;
    }

    const nativeCode = settings.nativeLanguageCode || "tr";
    const defaultTargetCode = settings.targetLanguageCode || "en";
    const resolvedSourceLang = (targetCode === nativeCode) ? defaultTargetCode : nativeCode;

    const cleanSourceValue = removeTranslationCommandSuffix(element);

    // Quote-aware payload: only own words get translated
    const payloadBase = {
      sourceLanguage: resolvedSourceLang,
      nativeLanguageCode: nativeCode,
      targetLanguage: targetCode,
      useAutoDetect: settings.useAutoDetect === true,
      flipOnSameLanguage: true
    };

    // If confirm is OFF, just translate and replace immediately
    if (!settings.showConfirmModal) {
      // Only show loading for non-builtin models
      if (settings.activeProviderId !== "builtin") {
        showToast(i18n.t("toast.translating"));
      }
      let out;
      try {
        out = await translateFieldOwnText(cleanSourceValue, payloadBase);
      } catch (e) {
        showToast(e?.message ? String(e.message) : i18n.t("toast.translationFailed"));
        return;
      }

      if (out?.res?.contextInvalidated) return;

      if (out?.failed) {
        showToast(out.res?.error || i18n.t("toast.translationFailed"));
        return;
      }
      if (out?.ok && out.translation) {
        setFieldText(element, out.translation);
        lastAppliedText = stripInvisibleChars(out.translation || "");
        lastAppliedAt = Date.now();
      } else if (out?.skipped) {
        // nothing own to translate — leave the field untouched
      } else {
        showToast(i18n.t("toast.translationFailed"));
      }
      return;
    }

    // If confirm is ON, show inline suggestion
    // Only show loading for non-builtin models
    if (settings.activeProviderId !== "builtin") {
      showToast(i18n.t("toast.translating"));
    }

    let out;
    try {
      out = await translateFieldOwnText(cleanSourceValue, payloadBase);
    } catch (e) {
      showToast(e?.message ? String(e.message) : i18n.t("toast.translationFailed"));
      return;
    }

    if (out?.res?.contextInvalidated) return;

    if (!out?.ok || !out.translation) {
      showToast(out?.failed && out.res?.error ? String(out.res.error) : i18n.t("toast.translationFailed"));
      return;
    }

    const translation = out.translation;
    const providerInfo = `${out.meta.providerName || 'AI'} (${out.meta.providerType || 'Bot'})`;

    // Use buildInlineSuggestion with auto positioning
    suggestion = buildInlineSuggestion(element, translation, providerInfo, 'auto');
    suggestion._segments = out.segments;
    suggestion._ownJoined = out.ownJoined;
    
    // Setup Tab/Esc handlers
    const handleKeydown = (ev) => {
      if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing)) {
        // RAT-FIX: Enter also applies the translation (never sends raw text)
        ev.preventDefault();
        setFieldText(element, translation);
        suggestion.destroy();
        document.removeEventListener("keydown", handleKeydown, true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        suggestion.destroy();
        document.removeEventListener("keydown", handleKeydown, true);
      }
    };

    document.addEventListener("keydown", handleKeydown, true);

    // Cleanup if element loses focus or is removed
    const onBlur = () => {
      suggestion.destroy();
      document.removeEventListener("keydown", handleKeydown, true);
      element.removeEventListener("blur", onBlur);
    };
    element.addEventListener("blur", onBlur);

  } catch (err) {
    if (suggestion) suggestion.destroy();
    showToast(err.message || "An error occurred");
    console.error(err);
  } finally {
    if (translatingTimeout) {
      clearTimeout(translatingTimeout);
      translatingTimeout = null;
    }
    isTranslating = false;
  }
}

// ============================================
// INSTANT TRANSLATE MODE
// ============================================

function isInstantDomain(settings) {
  // Kept for backward compatibility of call sites; the model is now
  // "enabled on all sites" with an opt-out exclusion list.
  return isInstantAllowed(settings)
    ? { position: settings.instantPosition || "auto" }
    : null;
}

// ============================================
// QUOTE-AWARE SEGMENTATION
// ============================================
// When replying on a forum the field usually contains quoted material
// ([quote] BBCode, > markdown lines, <blockquote> HTML) plus the user's own
// words. Only the user's own words may be translated — quoted authors' text
// must pass through untouched. This is message-format logic, generic for all
// sites, never site-specific.

function segmentQuotedText(text) {
  const segments = [];
  const push = (type, start, end) => {
    if (end > start) segments.push({ type, text: text.slice(start, end) });
  };

  const ranges = [];
  let m;

  // BBCode quotes: [quote], [quote=author], [quote=author date]...[/quote]
  const bb = /\[quote[^\]]*\][\s\S]*?(?:\[\/quote\]|$)/gi;
  while ((m = bb.exec(text))) ranges.push([m.index, m.index + m[0].length]);

  // HTML blockquotes (rich editors that keep serialized HTML)
  const bq = /<blockquote[\s\S]*?<\/blockquote>|<blockquote[^>]*>[\s\S]*$/gi;
  while ((m = bq.exec(text))) ranges.push([m.index, m.index + m[0].length]);

  // Markdown / Discord quote lines: lines starting with >
  if (ranges.length === 0) {
    const lineRe = /(?:^|\n)[ \t]{0,3}>[^\n]*/g;
    while ((m = lineRe.exec(text))) {
      let start = m.index;
      if (text[start] === "\n") start += 1;
      ranges.push([start, m.index + m[0].length]);
    }
  }

  if (ranges.length === 0) return [{ type: "own", text }];

  // Merge overlapping ranges, then split into quote/own segments
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  let pos = 0;
  for (const [s, e] of merged) {
    push("own", pos, s);
    push("quote", s, e);
    pos = e;
  }
  push("own", pos, text.length);
  return segments;
}

function ownSegments(segments) {
  return segments.filter((s) => s.type === "own" && s.text.trim().length > 0);
}

// Rebuild the full field text: quoted segments untouched, own segments
// replaced by their translations (aligned 1:1 in order).
function rebuildWithTranslations(segments, translatedOwn) {
  let i = 0;
  return segments
    .map((s) => (s.type === "own" && s.text.trim().length > 0 ? translatedOwn[i++] : s.text))
    .join("");
}

function stripInvisibleChars(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function shouldTriggerInstant(text) {
  // Don't trigger if:
  if (!text || text.trim().length < 5) return false; // Too short
  if (/^https?:\/\//.test(text)) return false; // URL
  if (/^[!@#$%^&*()_+=\[\]{};':"\\|,.<>\/?`~-]+$/.test(text)) return false; // Only special chars
  return true;
}

async function setFieldText(element, text, options = {}) {
  if (!element) return false;

  // Adaptive apply engine: every site/editor accepts text differently (React
  // value tracking, Lexical/ProseMirror beforeinput contracts, Quill/TinyMCE/
  // SCEditor paste handlers, jQuery watchers). Try strategies in order and
  // VERIFY the text actually stuck; the first verified one wins. Between
  // attempts the field is restored to its original content so failed
  // strategies never compound into a mangled editor.
  const tag = element.tagName?.toLowerCase();
  const isBox = tag === "input" || tag === "textarea";
  const strategies = isBox
    ? ["native-setter", "plain-value", "input-event", "paste"]
    : ["page-world", "exec-insert", "paste", "beforeinput", "range-replace"];

  const normalizedTarget = String(text || "").replace(/\s+/g, " ").trim();

  if (document.activeElement !== element) {
    try { element.focus(); } catch (e) {}
  }

  // Snapshot the original content for contenteditable restore. Keep a deep
  // template: the restore must be repeatable across every strategy retry.
  let snapshotTemplate = null;
  if (!isBox) {
    try { snapshotTemplate = element.cloneNode(true); } catch (e) {}
  }

  const verified = () => {
    if (!normalizedTarget) return true;
    const now = readFieldText(element).replace(/\s+/g, " ").trim();
    return now === normalizedTarget;
  };

  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  for (let i = 0; i < strategies.length; i++) {
    // Restore original content before retrying with the next strategy
    if (i > 0 && snapshotTemplate) {
      try {
        const fresh = snapshotTemplate.cloneNode(true);
        element.replaceChildren(...Array.from(fresh.childNodes));
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        if (document.activeElement !== element) { try { element.focus(); } catch (e) {} }
      } catch (e) {}
    }

    // Let model-driven editors finish reconciling the previous attempt's
    // DOM changes; a page-world edit landing mid-reconciliation gets reverted.
    if (!isBox && i > 0) await raf();

    if (strategies[i] === "page-world") {
      const ok = await applyPageWorldInsert(element, text).catch(() => false);
      if (!ok) continue;
    } else {
      try {
        applyFieldStrategy(element, strategies[i], text, isBox);
      } catch (e) {
        continue;
      }
    }

    if (isBox) {
      if (verified()) return true;
      continue;
    }

    // Model-driven editors (Lexical, ProseMirror, Quill) reconcile their DOM
    // asynchronously; give them two frames before judging the result.
    await raf(); await raf();
    if (verified()) return true;
  }
  return false;
}

function readFieldText(element) {
  if (!element) return "";
  const tag = element.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return element.value || "";
  return element.innerText || element.textContent || "";
}

// Re-run the select-all + insert edit inside the page's MAIN world, targeted
// AT the exact element (CustomEvent target preserves identity even when the
// editor re-renders). Model-driven editors only honor edits that go through
// the page's real event pipeline.
function applyPageWorldInsert(element, text) {
  return new Promise((resolve) => {
    if (!isExtensionContextValid()) return resolve(false);

    const nonce = Math.random().toString(36).slice(2);
    let settled = false;

    const onResult = (e) => {
      if (!e.detail || e.detail.nonce !== nonce) return;
      settled = true;
      element.removeEventListener("__transkitPageExecResult", onResult);
      resolve(!!e.detail.ok);
    };
    element.addEventListener("__transkitPageExecResult", onResult);

    try {
      element.dispatchEvent(
        new CustomEvent("__transkitPageExec", {
          bubbles: true,
          cancelable: false,
          detail: { text, nonce }
        })
      );
    } catch (e) {
      settled = true;
      resolve(false);
    }

    setTimeout(() => {
      if (!settled) {
        element.removeEventListener("__transkitPageExecResult", onResult);
        resolve(false);
      }
    }, 250);
  });
}

function nativeValueSetter(element, isBox) {
  return Object.getOwnPropertyDescriptor(
    isBox ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
}

function applyFieldStrategy(element, strategy, text, isBox) {
  const tag = element.tagName?.toLowerCase();

  if (isBox) {
    if (strategy === "native-setter") {
      const setter = nativeValueSetter(element, isBox);
      if (setter) setter.call(element, text);
      else element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (strategy === "plain-value") {
      element.value = text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (strategy === "input-event") {
      const setter = nativeValueSetter(element, isBox);
      if (setter) setter.call(element, text);
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true, data: text, inputType: "insertReplacementText"
      }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (strategy === "paste") {
      try {
        element.setSelectionRange(0, element.value.length);
      } catch (_) {}
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt
      }));
    }
    try {
      element.setSelectionRange(element.value.length, element.value.length);
    } catch (_) {}
    return;
  }

  // contenteditable strategies
  if (strategy === "exec-insert") {
    // selectAll via execCommand keeps model-driven editors (Lexical,
    // ProseMirror, Quill) in sync — a manual DOM range is ignored by their
    // internal selection state and the insert ends up appended at the caret.
    let selDone = false;
    try {
      selDone = document.execCommand("selectAll", false, null);
    } catch (e) {}
    if (!selDone) {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(element);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        element.textContent = text;
      }
    }
    const ok = document.execCommand("insertText", false, text);
    if (!ok) element.textContent = text;
    try { window.getSelection()?.collapseToEnd(); } catch (_) {}
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (strategy === "paste") {
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch (_) {}
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true, cancelable: true, clipboardData: dt
    }));
  } else if (strategy === "beforeinput") {
    // Lexical / ProseMirror / Quill consume beforeinput themselves and apply
    // the data through their own model — dispatch only, never stomp the DOM.
    element.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, cancelable: true,
      inputType: "insertReplacementText", data: text
    }));
  } else if (strategy === "range-replace") {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
      try { sel.collapseToEnd(); } catch (_) {}
    }
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true, data: text, inputType: "insertText"
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function buildInlineSuggestion(element, translatedText, providerInfo, position = 'auto', settings = {}) {
  const container = document.createElement('div');
  container.className = 'bt-inline-suggestion bt-vars-container';
  container.style.userSelect = 'none';
  container.style.webkitUserSelect = 'none';

  // Position relative to input
  const rect = element.getBoundingClientRect();
  container.style.position = 'fixed';
  container.style.zIndex = '9999999999';

  // Smart width calculation to prevent UI breaking on small inputs
  const minPopupWidth = 320;
  const maxPopupWidth = 600;
  const inputWidth = rect.width;

  // Calculate popup width with constraints
  let popupWidth = Math.max(inputWidth - 80, minPopupWidth);
  popupWidth = Math.min(popupWidth, maxPopupWidth);

  container.style.width = `${popupWidth}px`;
  container.style.minWidth = `${minPopupWidth}px`;
  container.style.maxWidth = `${maxPopupWidth}px`;

  // Smart horizontal positioning
  let leftPos = rect.left;

  // Get available viewport considering panels
  const viewport = getAvailableViewport();

  // If popup is wider than input, center it relative to input
  if (popupWidth > inputWidth) {
    leftPos = rect.left - (popupWidth - inputWidth) / 2;

    // Keep popup within viewport considering panel offsets
    const maxLeft = viewport.width + viewport.leftOffset - popupWidth - 10;
    const minLeft = viewport.leftOffset + 10;
    leftPos = Math.max(minLeft, Math.min(leftPos, maxLeft));
  }

  container.style.left = `${leftPos}px`;

  // AUTO-DETECT optimal vertical position
  let finalPosition = position;

  if (position === 'auto') {
    // Calculate available space above and below
    const spaceAbove = rect.top;
    const spaceBelow = viewport.height - rect.bottom;

    // Estimate popup height (will be more accurate after render)
    const estimatedPopupHeight = 100;
    const minSpaceNeeded = 120;

    // Prefer bottom if enough space, otherwise use position with more space
    if (spaceBelow >= minSpaceNeeded) {
      finalPosition = 'bottom';
    } else if (spaceAbove >= minSpaceNeeded) {
      finalPosition = 'top';
    } else {
      // Choose side with more space
      finalPosition = spaceAbove > spaceBelow ? 'top' : 'bottom';
    }
  }

  // Set vertical position based on final decision
  if (finalPosition === 'top') {
    container.style.bottom = `${viewport.height - rect.top + 8}px`;
    container.classList.add('bt-popup-top');
  } else {
    container.style.top = `${rect.bottom + 8}px`;
    container.classList.add('bt-popup-bottom');
  }
  
  // Add to DOM first to get dimensions
  btSafeRoot().appendChild(container);
  
  // Get container dimensions and adjust position if needed
  const containerRect = container.getBoundingClientRect();
  
  // Ensure container stays within viewport bounds
  if (finalPosition === 'bottom' && containerRect.bottom > viewport.height - 10) {
    // If bottom position causes overflow, try top position
    if (rect.top - containerRect.height - 8 >= 10) {
      container.style.top = '';
      container.style.bottom = `${viewport.height - rect.top + 8}px`;
      container.classList.remove('bt-popup-bottom');
      container.classList.add('bt-popup-top');
    } else {
      // Adjust to fit within viewport
      container.style.top = `${Math.max(10, viewport.height - containerRect.height - 10)}px`;
    }
  } else if (finalPosition === 'top' && containerRect.top < 10) {
    // If top position causes overflow, try bottom position
    if (rect.bottom + containerRect.height + 8 <= viewport.height - 10) {
      container.style.bottom = '';
      container.style.top = `${rect.bottom + 8}px`;
      container.classList.remove('bt-popup-top');
      container.classList.add('bt-popup-bottom');
    } else {
      // Adjust to fit within viewport
      container.style.bottom = `${Math.max(10, viewport.height - containerRect.height - 10)}px`;
    }
  }
  
  // Remove from DOM temporarily to continue setup
  container.remove();
  
  container.innerHTML = `
    <div class="bt-suggestion-content">
      <span class="bt-suggestion-icon">🔄</span>
      <span class="bt-suggestion-text">${translatedText}</span>
      <kbd class="bt-suggestion-tab-hint">Tab</kbd>
    </div>
    <div class="bt-suggestion-footer">
      <div class="bt-suggestion-provider-container"></div>
    </div>
  `;
  
  // Prevent clicking on the suggestion from blurring the input
  // EXCEPT for select elements (allow clicking model selector)
  const preventBlur = (e) => {
    // Allow clicks on select elements
    if (e.target.tagName === 'SELECT' || e.target.closest('select')) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  container.addEventListener('mousedown', preventBlur);
  container.addEventListener('pointerdown', preventBlur);
  
  const providerContainer = container.querySelector('.bt-suggestion-provider-container');
  const providerSelect = populateProviderSelectorForSuggestion(providerContainer, settings);

  btSafeRoot().appendChild(container);

  return {
    element: container,
    translatedText,
    providerSelect,
    destroy: () => {
      container.remove();
    }
  };
}

function populateProviderSelectorForSuggestion(container, settings) {
  const providers = settings.providers || [];
  const activeId = settings.activeProviderId || 'builtin';

  if (providers.length <= 1) {
    // Show as a label tag
    const provider = providers[0] || { name: 'Chrome Built-in AI' };
    const tag = document.createElement('span');
    tag.className = 'bt-model-tag';
    tag.textContent = provider.name;
    container.appendChild(tag);
    return null;
  } else {
    // Show as a select dropdown
    const label = document.createElement('span');
    label.className = 'bt-suggestion-provider-label';
    label.textContent = 'Model: ';
    
    const select = document.createElement('select');
    select.className = 'bt-suggestion-provider-select';
    select.tabIndex = -1; // CRITICAL: Prevent Tab key from focusing this element
    
    providers.forEach(p => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      if (p.id === activeId) option.selected = true;
      select.appendChild(option);
    });
    
    container.appendChild(label);
    container.appendChild(select);
    
    return select;
  }
}


function setupSuggestionKeyHandlers(element, suggestion) {
  // CRITICAL: Remove any existing handler first
  if (currentKeyHandler) {
    window.removeEventListener("keydown", currentKeyHandler, true);
    window.removeEventListener("keyup", currentKeyHandler, true);
    document.removeEventListener("keydown", currentKeyHandler, true);
    document.removeEventListener("keyup", currentKeyHandler, true);
    currentKeyHandler = null;
  }

  let isApplying = false; // Prevent multiple calls

  const handleKey = (ev) => {
    // RAT-FIX: Enter applies the translation too (never sends the raw text).
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      if (ev.type === "keyup") return false;
      if (isApplying) return false;
      applyTranslation();
      return false;
    }

    // Only handle specific keys, let everything else pass through
    if (ev.key === "Tab") {
      // CRITICAL: Block ALL propagation immediately and synchronously
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      // Legacy support
      if (ev.returnValue !== undefined) {
        ev.returnValue = false;
      }

      // Only process on keydown, just block keyup
      if (ev.type === "keyup") return false;

      // Prevent multiple calls
      if (isApplying) return false;

      // Apply translation (async, but we don't await in event handler)
      applyTranslation();
      return false;
    }

    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      if (ev.type === "keyup") return false;
      dismiss();
      return false;
    }

    if (ev.key === "Backspace" || ev.key === "Delete") {
      if (ev.type === "keyup") return;
      dismiss();
      return;
    }
  };

  const applyTranslation = async () => {
    // Prevent re-entry
    if (isApplying) return;
    isApplying = true;

    // Commit IME composition before applying translation and wait for completion
    await commitIMEComposition(element);

    // Cleanup FIRST to prevent any interference
    window.removeEventListener("keydown", handleKey, true);
    window.removeEventListener("keyup", handleKey, true);
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("keyup", handleKey, true);
    currentKeyHandler = null;

    // Set flag to prevent instant translate from re-triggering
    justAppliedTranslation = true;

    // Apply OUTSIDE the keydown task in a clean macrotask: model-driven
    // editors (Lexical etc.) swallow inserts that arrive within one macrotask
    // of a handled keydown ("bogus text replacement" guard).
    setTimeout(() => {
      setFieldText(element, suggestion.translatedText, { immediate: true });
      lastAppliedText = stripInvisibleChars(suggestion.translatedText || "");
      lastAppliedAt = Date.now();
    }, 0);

    // Destroy popup after a tiny delay to ensure insertion completes
    setTimeout(() => {
      if (suggestion) {
        suggestion.destroy();
      }
      currentSuggestion = null;
    }, 50);

    // Clear flag after a short delay (editors reconcile async; keep the
    // suppression window long enough to cover their input events)
    setTimeout(() => {
      justAppliedTranslation = false;
    }, 1500);
  };

  const dismiss = () => {
    window.removeEventListener("keydown", handleKey, true);
    window.removeEventListener("keyup", handleKey, true);
    document.removeEventListener("keydown", handleKey, true);
    document.removeEventListener("keyup", handleKey, true);
    currentKeyHandler = null;
    suggestion.destroy();
    currentSuggestion = null;
  };

  // Store reference and add listeners at MULTIPLE levels with CAPTURE
  // This ensures we catch the event before Facebook's handlers
  currentKeyHandler = handleKey;

  // Add at both window and document level for maximum coverage
  window.addEventListener("keydown", handleKey, true);
  window.addEventListener("keyup", handleKey, true);
  document.addEventListener("keydown", handleKey, true);
  document.addEventListener("keyup", handleKey, true);
}

// Commit IME composition by blur/focus
// This is needed for macOS IME (Vietnamese, Chinese, Japanese, etc.)
// to ensure the underline is removed before showing the translation popup
async function commitIMEComposition(element) {
  if (!isIMEComposing) return;

  try {
    // Blur triggers browser to fire compositionend event and commit IME
    element.blur();
    await new Promise(resolve => setTimeout(resolve, 10));

    // Re-focus to keep input active
    element.focus();
    await new Promise(resolve => setTimeout(resolve, 50));
  } catch (err) {
    console.error("Error committing IME composition:", err);
  }
}

// Translate ONLY the user's own words in a field. Quoted segments pass
// through untouched and are spliced back around the translated own text.
async function translateFieldOwnText(rawText, payloadBase) {
  const segments = segmentQuotedText(rawText);
  const own = ownSegments(segments);
  if (own.length === 0) return { skipped: true };

  const joined = own.map((s) => s.text.trim()).join("\n\n");
  const res = await requestTranslation({ ...payloadBase, text: joined });
  if (!res?.ok || !res.result?.translation) return { failed: true, res };

  const parts = res.result.translation.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  let translatedOwn;
  if (parts.length === own.length) {
    translatedOwn = parts;
  } else if (own.length === 1) {
    translatedOwn = [res.result.translation.trim()];
  } else {
    // Alignment failed (paragraph count changed) — translate each own
    // segment separately so quotes and own text never mix up.
    translatedOwn = [];
    for (const s of own) {
      const r = await requestTranslation({ ...payloadBase, text: s.text.trim() });
      if (!r?.ok || !r.result?.translation) return { failed: true, res: r };
      translatedOwn.push(r.result.translation.trim());
    }
  }

  return {
    ok: true,
    translation: rebuildWithTranslations(segments, translatedOwn),
    ownJoined: joined,
    segments,
    ownCount: own.length,
    meta: res.result
  };
}

async function handleInstantTranslate(element) {
  // Skip if we just applied a translation
  if (justAppliedTranslation) return;

  // Never touch password fields
  if (element?.tagName?.toLowerCase() === "input" &&
      (element.getAttribute("type") || "text").toLowerCase() === "password") {
    return;
  }

  const text = stripInvisibleChars(element.value || element.innerText || "");
  if (!shouldTriggerInstant(text)) return;

  // Suppress re-triggering on our own applied translation: editors fire
  // their own async input events after we replace the text (often later
  // than the 500ms justAppliedTranslation window).
  if (text === lastAppliedText && Date.now() - lastAppliedAt < 2500) return;

  // Quote-aware: only the user's own words count for the trigger
  const preSegments = segmentQuotedText(text);
  const preOwn = ownSegments(preSegments);
  if (preOwn.length === 0) return; // field contains only quoted material
  if (!preOwn.some((s) => shouldTriggerInstant(s.text))) return;

  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    return; // Silently fail if settings unavailable
  }

  const domainConfig = isInstantDomain(settings);
  if (!domainConfig) return;

  // Clear existing timer
  if (instantTimer) {
    clearTimeout(instantTimer);
    instantTimer = null;
  }

  // Dismiss existing suggestion
  if (currentSuggestion) {
    currentSuggestion.destroy();
    currentSuggestion = null;
  }

  // Start new timer
  instantTimer = setTimeout(async () => {
    try {
      // SPA re-render may have removed the field while we waited
      if (!element.isConnected) return;

      // Commit IME composition before translation
      await commitIMEComposition(element);

      // Get fresh text after IME composition is committed
      let freshText = stripInvisibleChars(element.value || element.innerText || "");
      // RAT-FIX: strip a trailing !!lang command before translating so it never
      // leaks into the result ("!!" leftover bug).
      if (freshText && TRANSLATION_COMMAND_PATTERN.test(freshText)) {
        freshText = freshText.replace(TRANSLATION_COMMAND_PATTERN, "").trimEnd();
      }

      // Quote-aware: skip when nothing own is left to translate
      const preSegs = segmentQuotedText(freshText);
      const preOwnSegs = ownSegments(preSegs);
      if (preOwnSegs.length === 0 || !preOwnSegs.some((s) => shouldTriggerInstant(s.text))) return;

      // Only show loading for non-builtin models
      if (settings.activeProviderId !== "builtin") {
        showToast(i18n.t("toast.translating"));
      }

      const out = await translateFieldOwnText(freshText, {
        nativeLanguageCode: settings.nativeLanguageCode || "en",
        targetLanguage: settings.targetLanguageCode || "en",
        sourceLanguage: settings.nativeLanguageCode || "en", // Preferred direction: native -> target
        useAutoDetect: false,
        flipOnSameLanguage: true // If text is already in the target language, flip direction
      });

      if (!element.isConnected) return;

      if (out?.res?.contextInvalidated) { cleanupExtensionElements(); return; }
      if (out?.failed) {
        showToast(out.res?.error || i18n.t("toast.translationFailed"));
        return;
      }
      if (!out?.ok) return;

      const position = domainConfig.position || 'auto';
      const providerInfo = `${out.meta.providerName || 'AI'} (${out.meta.providerType || 'Bot'})`;
      currentSuggestion = buildInlineSuggestion(element, out.translation, providerInfo, position, settings);
      currentSuggestion._segments = out.segments;
      currentSuggestion._ownJoined = out.ownJoined;
      setupSuggestionKeyHandlers(element, currentSuggestion);

      // Handle provider change
      if (currentSuggestion.providerSelect) {
        currentSuggestion.providerSelect.addEventListener('change', (e) => {
          reTranslateSuggestion(element, out.ownJoined, e.target.value, settings);
        });
      }
    } catch (err) {
      console.error("Instant translate error:", err);
      showToast(i18n.t("toast.translationFailed"));
    }
  }, Math.max(200, settings.instantDelay || 300));
}

async function reTranslateSuggestion(element, ownJoinedText, providerId, settings) {
  if (!currentSuggestion) return;

  const textEl = currentSuggestion.element.querySelector('.bt-suggestion-text');
  if (textEl) {
    textEl.textContent = i18n.t("dialog.translating");
    textEl.classList.add('bt-loading-text');
  }

  try {
    const res = await requestTranslation({
      text: ownJoinedText,
      nativeLanguageCode: settings.nativeLanguageCode || "en",
      targetLanguage: settings.targetLanguageCode || "es",
      useAutoDetect: settings.useAutoDetect === true,
      flipOnSameLanguage: true,
      providerId: providerId
    });

    if (res?.ok && res.result?.translation) {
      // Rebuild around quotes so provider switching never leaks quotes
      let final = res.result.translation;
      if (currentSuggestion._segments && ownSegments(currentSuggestion._segments).length > 0) {
        const parts = final.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
        const own = ownSegments(currentSuggestion._segments);
        if (parts.length === own.length) {
          final = rebuildWithTranslations(currentSuggestion._segments, parts);
        }
      }
      if (textEl) {
        textEl.textContent = final;
        textEl.classList.remove('bt-loading-text');
      }
      currentSuggestion.translatedText = final;
    }
  } catch (err) {
    console.error("Re-translation error:", err);
    if (textEl) {
      textEl.textContent = "Error: " + err.message;
      textEl.classList.remove('bt-loading-text');
    }
  }
}


function registerInstantMode() {
  // Common typing handler shared by input and beforeinput listeners. Some
  // model-driven editors (CKEditor5) preventDefault native editing and never
  // fire "input" — only "beforeinput" — so both are wired to the same
  // debounced path (handleInstantTranslate re-arms its timer, so duplicates
  // from editors firing both events are harmless).
  const onTypingEvent = async (e) => {
    // Resolve the editable element from the event itself: composedPath()
    // crosses shadow roots, so this works on sites where document.activeElement
    // is a host element or where focus is moved programmatically after typing.
    const element = resolveEditableFromEvent(e);
    if (!element) return;

    // Don't interfere with manual mode
    if (isTranslating) return;

    // Check if manual command is being typed
    const text = element.value?.trim() || element.innerText?.trim();
    if (TRANSLATION_COMMAND_PATTERN.test(text)) return;

    handleInstantTranslate(element);
  };

  // Listen for input changes
  document.addEventListener('input', onTypingEvent, true);
  document.addEventListener('beforeinput', (e) => {
    if (typeof e.inputType === "string" && e.inputType.startsWith("insert")
        && !e.inputType.includes("Composition")) {
      onTypingEvent(e);
    }
  }, true);

  // Track IME composition state for proper handling
  document.addEventListener('compositionstart', () => {
    isIMEComposing = true;
  }, true);

  document.addEventListener('compositionend', () => {
    isIMEComposing = false;
  }, true);

  // Handle click outside to close suggestion
  document.addEventListener('mousedown', (e) => {
    if (currentSuggestion) {
      const isInsideInput = e.target === getActiveEditableElement();
      const isInsideSuggestion = currentSuggestion.element.contains(e.target);
      
      if (!isInsideInput && !isInsideSuggestion) {
        // Cleanup key handler if it exists
        if (currentKeyHandler) {
          document.removeEventListener("keydown", currentKeyHandler, true);
          currentKeyHandler = null;
        }
        
        currentSuggestion.destroy();
        currentSuggestion = null;
      }
    }
  });
  
  // Any editing keypress while a suggestion is visible kills it immediately,
  // so the popup never hangs around while the user deletes/edits text (this
  // covers editors that never fire native input events, like SCEditor).
  document.addEventListener('keydown', (e) => {
    if (!currentSuggestion) return;
    if (e.key === "Tab" || e.key === "Enter" || e.key === "Escape") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (currentKeyHandler) {
      document.removeEventListener("keydown", currentKeyHandler, true);
      window.removeEventListener("keydown", currentKeyHandler, true);
      document.removeEventListener("keyup", currentKeyHandler, true);
      window.removeEventListener("keyup", currentKeyHandler, true);
      currentKeyHandler = null;
    }
    currentSuggestion.destroy();
    currentSuggestion = null;
    if (instantTimer) {
      clearTimeout(instantTimer);
      instantTimer = null;
    }
  }, true);

  // Listen for Enter key to cancel instant translate
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // User wants to send message immediately, cancel any pending translation
      if (instantTimer) {
        clearTimeout(instantTimer);
        instantTimer = null;
      }
      
      // Dismiss any visible suggestion
      if (currentSuggestion) {
        currentSuggestion.destroy();
        currentSuggestion = null;
      }
      
      // Remove keyboard handler if active
      if (currentKeyHandler) {
        document.removeEventListener("keydown", currentKeyHandler, true);
        currentKeyHandler = null;
      }
    }
  }, true);
}

// ============================================
// INSTANT TOGGLE SHORTCUT
// ============================================

async function toggleInstantDomainForCurrentUrl() {
  try {
    const settings = await getSettings();
    const host = window.location.hostname;

    // Global toggle: off -> on enables instant everywhere
    if (!settings.instantTranslateEnabled) {
      settings.instantTranslateEnabled = true;
      try {
        await safeRuntimeCall(() => chrome.runtime.sendMessage({
          type: "set-settings",
          settings: settings
        }));
      } catch (error) {
        console.log('TransKit: Error saving settings:', error.message);
        return;
      }
      showToast(i18n.t("toast.instantEnabled") || "⚡ Instant translate enabled (all sites)");
      return;
    }

    // Global is on: toggle the current site in the exclusion (opt-out) list
    if (!Array.isArray(settings.instantExcludedDomains)) {
      settings.instantExcludedDomains = [];
    }

    const list = settings.instantExcludedDomains;
    const index = list.findIndex((d) => hostMatchesPattern(host, d?.domain));
    let nowExcluded;

    if (index === -1) {
      list.push({ domain: host, enabled: true });
      nowExcluded = true;
    } else {
      list.splice(index, 1);
      nowExcluded = false;
    }

    try {
      await safeRuntimeCall(() => chrome.runtime.sendMessage({
        type: "set-settings",
        settings: settings
      }));
    } catch (error) {
      console.log('TransKit: Error updating settings:', error.message);
      return;
    }

    showToast(nowExcluded
      ? `${i18n.t("toast.instantDisabled") || "Instant translate disabled"} — ${host}`
      : `${i18n.t("toast.instantEnabled") || "⚡ Instant translate enabled"} — ${host}`);

    // Clear any pending instant translation when disabling
    if (nowExcluded && instantTimer) {
      clearTimeout(instantTimer);
      instantTimer = null;
    }

    // Dismiss current suggestion when disabling
    if (nowExcluded && currentSuggestion) {
      currentSuggestion.destroy();
      currentSuggestion = null;
    }
  } catch (err) {
    console.error("Toggle instant domain error:", err);
    showToast(i18n.t("toast.error") || "Error toggling instant domain");
  }
}

function extractDomainFromUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return window.location.hostname;
  }
}

// Alias: showToastBottomRight cũng sử dụng style modern
function showToastBottomRight(message) {
  showToast(message);
}

function registerInstantToggleShortcut() {
  document.addEventListener('keydown', async (e) => {
    const settings = await getSettings();
    const shortcut = settings.instantToggleShortcut || {
      key: "I",
      ctrl: true,
      shift: true,
      alt: false
    };

    // Check if shortcut matches
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifierKey = isMac ? e.metaKey : e.ctrlKey;

    const matches =
      e.key.toUpperCase() === shortcut.key.toUpperCase() &&
      modifierKey === shortcut.ctrl &&
      e.shiftKey === shortcut.shift &&
      e.altKey === shortcut.alt;

    if (matches) {
      e.preventDefault();
      e.stopPropagation();
      await toggleInstantDomainForCurrentUrl();
    }
  }, true);
}

// ============================================
// INSTANT LABEL INDICATOR
// ============================================

function registerInstantLabelIndicator() {
  // Create label element
  const label = document.createElement('div');
  const labelText = document.createElement('span');

  const fallbackIcon = document.createElement('span');
  fallbackIcon.textContent = '⚡';
  fallbackIcon.style.cssText = 'width: 14px; height: 14px; flex-shrink: 0; display: inline-block; text-align: center;';
  label.appendChild(fallbackIcon);
  label.appendChild(labelText);

  label.style.cssText = `
    position: fixed;
    user-select: none;
    -webkit-user-select: none;
    background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
    color: white;
    padding: 3px 6px;
    border-radius: 5px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    font-weight: 500;
    z-index: 9999999;
    pointer-events: none;
    display: none;
    align-items: center;
    gap: 3px;
    box-shadow: 0 2px 8px rgba(14, 165, 233, 0.25), 0 1px 3px rgba(0, 0, 0, 0.1);
    white-space: nowrap;
    backdrop-filter: blur(6px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    opacity: 0.88;
    animation: labelFadeIn 0.3s ease-out;
  `;

  btSafeRoot().appendChild(label);

  let currentSettings = null;
  let labelTimeout = null;

  // Load initial settings
  getSettings().then(s => {
    currentSettings = s;
  });

  // Update settings when they change
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.translatorSettings) {
      currentSettings = changes.translatorSettings.newValue;
    }
  });

  // Check if instant is enabled on this site (all-sites model with exclusions)
  function isInstantEnabledForCurrentDomain() {
    return isInstantAllowed(currentSettings || {});
  }

  // Hide label function
  function hideLabel() {
    if (labelTimeout) {
      clearTimeout(labelTimeout);
    }
    label.style.transition = 'opacity 0.3s ease-out';
    label.style.opacity = '0';
    setTimeout(() => {
      label.style.display = 'none';
      label.style.transition = 'none';
      label.style.opacity = '0.88';
    }, 300);
  }

  // Show label once on focus
  function handleInputFocus(e) {
    if (!isEditableElement(e.target) || !isInstantEnabledForCurrentDomain()) {
      return;
    }

    // Clear any existing timeout
    if (labelTimeout) {
      clearTimeout(labelTimeout);
    }

    // Get input position - align left
    const rect = e.target.getBoundingClientRect();
    const offsetY = rect.top - 35; // Position above input
    const offsetX = rect.left; // Align left with input

    // Update label text with i18n
    labelText.textContent = i18n.t("label.instant") || "Instant";

    // Show label
    label.style.left = `${offsetX}px`;
    label.style.top = `${offsetY}px`;
    label.style.display = 'flex';
    label.style.opacity = '0.88';
    label.style.transition = 'none';

    // Auto-hide after 3.5 seconds
    labelTimeout = setTimeout(() => {
      hideLabel();
    }, 3500);

    // Hide on blur
    const handleBlur = () => {
      hideLabel();
      e.target.removeEventListener('blur', handleBlur);
    };
    e.target.addEventListener('blur', handleBlur);
  }

  // Add focus listener on document (capture phase)
  document.addEventListener('focus', handleInputFocus, true);
}

// ============================================
// SELECT-TO-TRANSLATE MODE
// ============================================

function showTranslateIcon(x, y, selection) {
  hideTranslateIcon();
  
  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    console.log('TransKit: Extension context invalidated, skipping icon creation');
    return;
  }
  
  try {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    const icon = document.createElement('div');
    icon.className = 'bt-translate-icon bt-vars-container';
    icon.style.userSelect = 'none';
    icon.style.webkitUserSelect = 'none';
    
    icon.innerHTML = `<span style="font-size: 18px; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; line-height: 1;">🔄</span>`;
    
    icon.style.position = 'fixed';
    icon.style.zIndex = '9999999999';
    
    // Position near cursor - choose top or bottom based on viewport
    const viewport = getAvailableViewport();
    const spaceBelow = viewport.height - y;
    const spaceAbove = y;
    
    // If more space below, show below cursor; otherwise show above
    if (spaceBelow > 200 || spaceBelow > spaceAbove) {
      icon.style.left = `${x - 20}px`;
      icon.style.top = `${y + 12}px`;
      icon.dataset.position = 'bottom';
    } else {
      icon.style.left = `${x - 20}px`;
      icon.style.top = `${y - 48}px`;
      icon.dataset.position = 'top';
    }
    
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      // Pass selection rect instead of icon rect for better positioning
      showTranslationPopup(rect, selectedText, icon.dataset.position);
    });
    
    btSafeRoot().appendChild(icon);
    selectionIcon = icon;
  } catch (error) {
    console.log('TransKit: Error creating translate icon:', error.message);
    // Extension context might be invalidated, clean up
    if (error.message.includes('Extension context invalidated')) {
      cleanupExtensionElements();
    }
  }
}

function hideTranslateIcon() {
  if (selectionIcon) {
    selectionIcon.remove();
    selectionIcon = null;
  }
}

// Helper function to get actual available viewport considering panels/devtools
function getAvailableViewport() {
  // Get the document's visible area
  const documentElement = document.documentElement;
  const body = document.body;
  
  // Calculate actual available space
  // Use document.documentElement.clientWidth/Height which excludes scrollbars
  // and is more accurate for content positioning
  const availableWidth = Math.min(
    window.innerWidth,
    documentElement.clientWidth,
    body ? body.clientWidth : window.innerWidth
  );
  
  const availableHeight = Math.min(
    window.innerHeight,
    documentElement.clientHeight,
    body ? body.clientHeight : window.innerHeight
  );
  
  // Also consider if there are any fixed elements that might reduce available space
  // Check for common panel/sidebar patterns
  const rightPanels = document.querySelectorAll('[style*="position: fixed"][style*="right: 0"], .devtools-panel, .sidebar-panel');
  const leftPanels = document.querySelectorAll('[style*="position: fixed"][style*="left: 0"], .left-panel');
  
  let rightOffset = 0;
  let leftOffset = 0;
  
  rightPanels.forEach(panel => {
    const rect = panel.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      rightOffset = Math.max(rightOffset, rect.width);
    }
  });
  
  leftPanels.forEach(panel => {
    const rect = panel.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      leftOffset = Math.max(leftOffset, rect.width);
    }
  });
  
  return {
    width: Math.max(300, availableWidth - rightOffset - leftOffset), // Minimum 300px
    height: Math.max(200, availableHeight), // Minimum 200px
    leftOffset: leftOffset,
    rightOffset: rightOffset
  };
}

// Helper function to safely make chrome.runtime calls
async function safeRuntimeCall(callback) {
  if (!isExtensionContextValid()) {
    return null;
  }
  
  try {
    return await callback();
  } catch (error) {
    if (error?.message && (error.message.includes('Extension context invalidated') || !isExtensionContextValid())) {
      cleanupExtensionElements();
      return null;
    }
    console.warn('TransKit: safeRuntimeCall warning:', error?.message);
    return null;
  }
}

// Helper function to clean up extension elements when context is invalidated
function cleanupExtensionElements() {
  try {
    // Remove any existing popups or icons
    if (typeof hideTranslationPopup === 'function') {
      hideTranslationPopup();
    }
    if (typeof hideTranslateIcon === 'function') {
      hideTranslateIcon();
    }
    
    // Remove any inline suggestions
    if (typeof hideSuggestion === 'function') {
      hideSuggestion();
    }
    
    // Clear current suggestion
    if (currentSuggestion) {
      try {
        currentSuggestion.destroy();
      } catch (e) {
        // Ignore errors during cleanup
      }
      currentSuggestion = null;
    }
    
    // Clear timers
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    
    if (instantTimer) {
      clearTimeout(instantTimer);
      instantTimer = null;
    }
    
    // Clear any global timers
    if (window.transkitCleanupTimer) {
      clearTimeout(window.transkitCleanupTimer);
      window.transkitCleanupTimer = null;
    }
    
    // Remove event listeners if they exist
    if (currentKeyHandler) {
      try {
        window.removeEventListener("keydown", currentKeyHandler, true);
        window.removeEventListener("keyup", currentKeyHandler, true);
        document.removeEventListener("keydown", currentKeyHandler, true);
        document.removeEventListener("keyup", currentKeyHandler, true);
      } catch (e) {
        // Ignore errors during cleanup
      }
      currentKeyHandler = null;
    }
    
    // Remove any extension-created elements
    const extensionElements = document.querySelectorAll(
      '.bt-inline-suggestion, .bt-selection-popup, .bt-selection-icon, .bt-toast-notify, .bt-hover-popup, .bt-hover-translation, .bt-vars-container'
    );
    extensionElements.forEach(el => {
      try {
        el.remove();
      } catch (e) {
        // Ignore errors during cleanup
      }
    });
    
    console.info('TransKit: Extension detached cleanly due to context invalidation');
  } catch (error) {
    // Ignore cleanup errors
  }
}

// Helper function to ensure popup stays within viewport bounds
function ensurePopupInViewport(popup, selectionRect) {
  const rect = popup.getBoundingClientRect();
  const viewport = getAvailableViewport();
  
  let adjustedLeft = parseFloat(popup.style.left);
  let positionChanged = false;
  
  // Adjust horizontal position if popup goes off-screen
  // Consider left and right offsets from panels
  const maxRight = viewport.width + viewport.leftOffset - 10;
  const minLeft = viewport.leftOffset + 10;
  
  if (rect.right > maxRight) {
    adjustedLeft = maxRight - rect.width;
    popup.style.left = `${adjustedLeft}px`;
    positionChanged = true;
  }
  if (rect.left < minLeft) {
    adjustedLeft = minLeft;
    popup.style.left = `${adjustedLeft}px`;
    positionChanged = true;
  }
  
  // Recalculate arrow position if horizontal position changed
  if (positionChanged && selectionRect) {
    const selectionCenter = selectionRect.left + (selectionRect.width / 2);
    const newArrowLeft = selectionCenter - adjustedLeft;
    // Ensure arrow stays within popup bounds (at least 20px from edges)
    const clampedArrowLeft = Math.max(20, Math.min(newArrowLeft, rect.width - 20));
    popup.style.setProperty('--bt-arrow-left', `${clampedArrowLeft}px`);
  }
  
  // Adjust vertical position if popup goes off-screen
  if (popup.style.top && rect.bottom > viewport.height - 10) {
    // If using top positioning and popup goes below viewport
    const newTop = Math.max(10, viewport.height - rect.height - 10);
    popup.style.top = `${newTop}px`;
  }
  
  if (popup.style.bottom && rect.top < 10) {
    // If using bottom positioning and popup goes above viewport
    const newBottom = Math.max(10, viewport.height - rect.height - 10);
    popup.style.bottom = `${newBottom}px`;
  }
}

// Helper function to readjust popup position after content is loaded
function readjustPopupAfterContentLoad(popup, selectionRect) {
  // Wait a bit for content to render, then readjust
  setTimeout(() => {
    ensurePopupInViewport(popup, selectionRect);
  }, 100);
  
  // Also readjust after a longer delay to catch any async content loading
  setTimeout(() => {
    ensurePopupInViewport(popup, selectionRect);
  }, 500);
}

async function showTranslationPopup(selectionRect, text, iconPosition) {
  // Check if extension context is still valid
  if (!isExtensionContextValid()) {
    console.log('TransKit: Extension context invalidated, cannot show popup');
    return;
  }
  
  try {
    hideTranslationPopup();

    // Fetch settings first to ensure i18n is updated
    const settings = await getSettings();
    
    const popup = document.createElement('div');
    popup.className = 'bt-selection-popup bt-vars-container';
    popup.style.userSelect = 'none';
    popup.style.webkitUserSelect = 'none';
  popup.innerHTML = `
    <div class="bt-selection-bg-pattern"></div>
    <div class="bt-selection-header">
      <span class="bt-selection-title">
        <span style="float:left;margin-right:4px;font-size:16px;">🔄</span> 
        <span>${i18n.t("selection.title")}</span>
      </span>
      <button class="bt-selection-close">×</button>
    </div>
    <div class="bt-selection-content">
      <div class="bt-selection-original">
        <label>
          ${i18n.t("selection.original")}
          <select class="bt-selection-source-select"></select>
        </label>
        <div class="bt-selection-text-container bt-selection-content-style">
          <button class="bt-speak-btn bt-speak-source" title="Listen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path class="bt-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              <path class="bt-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
          </button>
          <div class="bt-selection-text-content">${text}</div>
        </div>
      </div>
      <div class="bt-selection-translated">
        <label>
          ${i18n.t("selection.translate")}
          <select class="bt-selection-target-select"></select>
        </label>
        <div class="bt-selection-result-container">
          <div class="bt-selection-text-container bt-selection-content-style">
            <button class="bt-speak-btn bt-speak-target" title="Listen">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path class="bt-wave-2" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                <path class="bt-wave-1" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
              </svg>
            </button>
            <div class="bt-selection-text-content bt-loading-text">${i18n.t("dialog.translating")}</div>
          </div>
          <button class="bt-selection-copy-btn" title="${i18n.t("selection.copy")}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span class="bt-copy-feedback">${i18n.t("selection.copied")}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="bt-selection-footer">
      <div class="bt-selection-provider-container">
        <!-- Provider selector or label will be injected here -->
      </div>
      <a href="#" class="bt-selection-settings">${i18n.t("selection.settings")}</a>
    </div>
  `;
  
  popup.style.position = 'fixed';
  popup.style.zIndex = '9999999999';
  
  // Center popup based on SELECTION rect
  // First, add popup to DOM to get actual dimensions
  btSafeRoot().appendChild(popup);
  const tempRect = popup.getBoundingClientRect();
  const actualPopupWidth = tempRect.width;
  
  // Get available viewport considering panels
  const viewport = getAvailableViewport();
  
  const selectionCenter = selectionRect.left + (selectionRect.width / 2);
  const left = selectionCenter - (actualPopupWidth / 2);
  
  // Ensure popup doesn't go off-screen horizontally
  // Consider panel offsets
  const maxLeft = viewport.width + viewport.leftOffset - actualPopupWidth - 10;
  const minLeft = viewport.leftOffset + 10;
  const finalLeft = Math.max(minLeft, Math.min(left, maxLeft));
  
  // Calculate arrow position relative to popup
  // Arrow should point to selection center
  const arrowLeft = selectionCenter - finalLeft;
  popup.style.setProperty('--bt-arrow-left', `${arrowLeft}px`);
  
  // Vertical positioning: close to selection with overflow check
  // Get initial popup dimensions after adding to DOM
  const initialRect = popup.getBoundingClientRect();
  
  // Estimate final popup height (accounting for content that will be loaded)
  // Use a more conservative estimate since content will be added
  const estimatedPopupHeight = Math.max(initialRect.height, 200); // Minimum 200px for safety
  
  // Calculate available space above and below selection
  const spaceAbove = selectionRect.top;
  const spaceBelow = viewport.height - selectionRect.bottom;
  
  // Determine best position based on available space and estimated popup height
  let finalPosition = iconPosition;
  
  if (iconPosition === 'bottom') {
    // Check if popup fits below selection with some buffer
    if (selectionRect.bottom + 8 + estimatedPopupHeight > viewport.height - 20) {
      // Not enough space below, check if there's more space above
      if (spaceAbove > spaceBelow && spaceAbove >= estimatedPopupHeight + 28) {
        finalPosition = 'top';
      }
    }
  } else {
    // Check if popup fits above selection with some buffer
    if (selectionRect.top - 8 - estimatedPopupHeight < 20) {
      // Not enough space above, check if there's more space below
      if (spaceBelow > spaceAbove && spaceBelow >= estimatedPopupHeight + 28) {
        finalPosition = 'bottom';
      }
    }
  }
  
  // Apply final positioning with better calculations
  if (finalPosition === 'bottom') {
    popup.style.left = `${finalLeft}px`;
    // Ensure popup doesn't go below viewport, with extra buffer
    const maxTop = viewport.height - estimatedPopupHeight - 20;
    popup.style.top = `${Math.min(selectionRect.bottom + 8, maxTop)}px`;
    popup.classList.add('bt-popup-bottom');
    popup.classList.remove('bt-popup-top');
  } else {
    popup.style.left = `${finalLeft}px`;
    // Ensure popup doesn't go above viewport, with extra buffer
    const maxBottom = viewport.height - selectionRect.top + 8;
    const minBottom = estimatedPopupHeight + 20;
    popup.style.bottom = `${Math.min(maxBottom, viewport.height - minBottom)}px`;
    popup.classList.add('bt-popup-top');
    popup.classList.remove('bt-popup-bottom');
  }
  selectionPopup = popup;
  
  // Store selectionRect for later use in readjustment
  popup._selectionRect = selectionRect;

  // Ensure popup stays within viewport bounds after positioning
  ensurePopupInViewport(popup, selectionRect);
  
  // Schedule readjustment after content loads
  readjustPopupAfterContentLoad(popup, selectionRect);
  
  // Final arrow position adjustment is now handled in ensurePopupInViewport

  // Make draggable
  const header = popup.querySelector('.bt-selection-header');
  makeDraggable(popup, header);
  
  // Hide icon when popup opens
  hideTranslateIcon();
  
  // Populate selectors (Mirror Logic)
  const nativeLang = settings.nativeLanguageCode || 'vi';
  const targetLang = settings.targetLanguageCode || 'en';
  
  let defaultSource, defaultTarget;
  
  if (!settings.useAutoDetect) { // Fixed direction (Mirror Logic)
    defaultSource = targetLang;
    defaultTarget = nativeLang;
  } else {
    // Auto-detect mode
    defaultSource = 'auto';
    defaultTarget = targetLang;
  }

  // Override with last used selection languages if available
  if (settings.selectionLastSource) {
    defaultSource = settings.selectionLastSource;
  }
  if (settings.selectionLastTarget) {
    defaultTarget = settings.selectionLastTarget;
  }
  
  // Populate selectors
  populateLanguageSelector(popup.querySelector('.bt-selection-source-select'), defaultSource, true);
  populateLanguageSelector(popup.querySelector('.bt-selection-target-select'), defaultTarget, false);
  
  // Initial translation
  translateSelectionWithSource(text, defaultSource, popup, null, defaultTarget);
  
  popup.querySelector('.bt-selection-close').addEventListener('click', () => {
    hideTranslationPopup();
    hideTranslateIcon();
  });
  
  popup.querySelector('.bt-selection-source-select').addEventListener('change', (e) => {
    const providerSelect = popup.querySelector('.bt-selection-provider-select');
    const providerId = providerSelect ? providerSelect.value : null;
    const targetLang = popup.querySelector('.bt-selection-target-select').value;
    
    // Save preference
    try {
      safeRuntimeCall(() => chrome.runtime.sendMessage({ 
        type: 'set-settings', 
        settings: { ...settings, selectionLastSource: e.target.value } 
      }));
    } catch (error) {
      console.log('TransKit: Error saving source preference:', error.message);
    }

    translateSelectionWithSource(text, e.target.value, popup, providerId, targetLang);
  });

  popup.querySelector('.bt-selection-target-select').addEventListener('change', (e) => {
    const providerSelect = popup.querySelector('.bt-selection-provider-select');
    const providerId = providerSelect ? providerSelect.value : null;
    const sourceLang = popup.querySelector('.bt-selection-source-select').value;

    // Save preference
    console.log('Saving selectionLastTarget:', e.target.value);
    try {
      safeRuntimeCall(() => chrome.runtime.sendMessage({ 
        type: 'set-settings', 
        settings: { ...settings, selectionLastTarget: e.target.value } 
      }));
    } catch (error) {
      console.log('TransKit: Error saving target preference:', error.message);
    }

    translateSelectionWithSource(text, sourceLang, popup, providerId, e.target.value);
  });

  // Populate provider selector
  const providerSelect = populateProviderSelector(popup, settings);
  if (providerSelect) {
    providerSelect.addEventListener('change', (e) => {
      const sourceLang = popup.querySelector('.bt-selection-source-select').value;
      const targetLang = popup.querySelector('.bt-selection-target-select').value;
      translateSelectionWithSource(text, sourceLang, popup, e.target.value, targetLang);
    });
  }
  
  // Settings link
  popup.querySelector('.bt-selection-settings').addEventListener('click', (e) => {
    e.preventDefault();
    try {
      safeRuntimeCall(() => chrome.runtime.sendMessage({ type: 'open-options' }));
    } catch (error) {
      console.log('TransKit: Error opening options:', error.message);
    }
  });

  // Copy button
  const copyBtn = popup.querySelector('.bt-selection-copy-btn');
  copyBtn.addEventListener('click', async () => {
    const textToCopy = popup.querySelector('.bt-selection-translated .bt-selection-text-content').textContent;
    if (!textToCopy || textToCopy === i18n.t("dialog.translating")) return;

    try {
      await navigator.clipboard.writeText(textToCopy);
      copyBtn.classList.add('bt-copied');
      setTimeout(() => copyBtn.classList.remove('bt-copied'), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  });
  


  // TTS Handlers
  popup.querySelector('.bt-speak-source').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('bt-speak-loading')) return;

    const sourceLang = popup.querySelector('.bt-selection-source-select').value;
    const textToSpeak = text; // Original text
    
    btn.classList.add('bt-speak-loading');
    try {
      await tts.play(textToSpeak, sourceLang === 'auto' ? 'en' : sourceLang);
    } catch (err) {
      console.error("TTS Error:", err);
    } finally {
      btn.classList.remove('bt-speak-loading');
    }
  });

  popup.querySelector('.bt-speak-target').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.classList.contains('bt-speak-loading')) return;

    const targetLang = popup.querySelector('.bt-selection-target-select').value;
    const textToSpeak = popup.querySelector('.bt-selection-translated .bt-selection-text-content').textContent;
    
    if (textToSpeak && textToSpeak !== i18n.t("dialog.translating")) {
      btn.classList.add('bt-speak-loading');
      try {
        await tts.play(textToSpeak, targetLang);
      } catch (err) {
        console.error("TTS Error:", err);
      } finally {
        btn.classList.remove('bt-speak-loading');
      }
    }
  });

  } catch (error) {
    console.log('TransKit: Error showing translation popup:', error.message);
    // Extension context might be invalidated, clean up
    if (error.message.includes('Extension context invalidated')) {
      cleanupExtensionElements();
    }
  }
}

function hideTranslationPopup() {
  if (selectionPopup) {
    selectionPopup.remove();
    selectionPopup = null;
  }
}

async function translateSelectionWithSource(text, sourceLang, popup, providerId = null, targetLangOverride = null) {
  const settings = await getSettings();
  const nativeLang = settings.nativeLanguageCode || 'vi';
  const targetLang = targetLangOverride || nativeLang;
  
  const translatedDiv = popup.querySelector('.bt-selection-translated .bt-selection-text-content');
  
  translatedDiv.textContent = i18n.t("dialog.translating");
  translatedDiv.classList.add('bt-loading-text');
  
  // If source and target are the same, return original text immediately
  if (sourceLang !== 'auto' && sourceLang === targetLang) {
    translatedDiv.textContent = text;
    translatedDiv.classList.remove('bt-loading-text');
    // Readjust popup position after content change
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
    return;
  }
  
  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: nativeLang,
      targetLanguage: targetLang,
      sourceLanguage: sourceLang, // Pass explicit source language
      useAutoDetect: sourceLang === 'auto' ? true : (settings.useAutoDetect === true),
      providerId: providerId // Pass provider override
    });
    
    if (res?.ok && res.result?.translation) {
      translatedDiv.textContent = res.result.translation;
      translatedDiv.classList.remove('bt-loading-text');
    } else {
      // Show actual error message from background/provider
      translatedDiv.textContent = res?.error || i18n.t("toast.translationFailed");
      translatedDiv.classList.remove('bt-loading-text');
    }
    
    // Readjust popup position after content is loaded
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
    
  } catch (err) {
    translatedDiv.textContent = 'Error: ' + err.message;
    translatedDiv.classList.remove('bt-loading-text');
    // Readjust popup position even on error
    setTimeout(() => ensurePopupInViewport(popup, popup._selectionRect), 50);
  }
}

function populateLanguageSelector(popup) {
  const select = popup.querySelector('.bt-selection-lang-select');
  const languages = [
    'vi', 'en', 'zh', 'ja', 'ko', 'es', 'fr', 'de'
  ];
  
  languages.forEach(code => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = i18n.t("lang." + code);
    select.appendChild(option);
  });
  
  getSettings().then(settings => {
    select.value = settings.nativeLanguageCode || 'vi';
  });
}

let lastPopupCloseTime = 0;

function registerSelectionMode() {
  document.addEventListener('mouseup', (e) => {
    // Ignore if clicking on icon or popup
    if (e.target.closest('.bt-translate-icon') || e.target.closest('.bt-selection-popup')) {
      return;
    }

    // Ignore if we just closed the popup (within 200ms)
    if (Date.now() - lastPopupCloseTime < 200) {
      return;
    }

    setTimeout(() => {
      const selection = window.getSelection();
      const text = selection.toString().trim();
      
      if (text && text.length > 0) {
        // If popup is already open for this text, don't show icon
        if (selectionPopup && selectedText === text) {
          return;
        }
        
        selectedText = text;
        showTranslateIcon(e.clientX, e.clientY, selection);
      } else {
        hideTranslateIcon();
        // Don't hide popup here, let mousedown handle it (so we can copy text from popup)
      }
    }, 10);
  });
  
  document.addEventListener('mousedown', (e) => {
    // 1. Handle Popup Open State
    if (selectionPopup) {
      if (!selectionPopup.contains(e.target)) {
        // Clicked outside popup
        // Prevent default to PRESERVE selection
        e.preventDefault();
        e.stopPropagation();
        hideTranslationPopup();
        lastPopupCloseTime = Date.now();
      }
      return;
    }

    // 2. Handle Icon Open State (Popup is closed)
    if (selectionIcon) {
      if (!selectionIcon.contains(e.target)) {
        // Clicked outside icon
        // Let default behavior happen (selection clears)
        hideTranslateIcon();
      }
    }
  });
}

function populateLanguageSelector(select, defaultValue = 'auto', includeAuto = true) {
  if (!select) return;
  
  const languages = includeAuto 
    ? ['auto', 'en', 'vi', 'zh', 'ja', 'ko', 'es', 'fr', 'de']
    : ['en', 'vi', 'zh', 'ja', 'ko', 'es', 'fr', 'de'];
  
  languages.forEach(code => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = i18n.t("lang." + code);
    select.appendChild(option);
  });
  
  select.value = defaultValue;
}

function populateProviderSelector(popup, settings) {
  const container = popup.querySelector('.bt-selection-provider-container');
  const providers = settings.providers || [];
  const activeId = settings.activeProviderId || 'builtin';

  if (providers.length <= 1) {
    // Show as a label tag
    const provider = providers[0] || { name: 'Chrome Built-in AI' };
    const tag = document.createElement('span');
    tag.className = 'bt-selection-provider-tag';
    tag.textContent = `Model: ${provider.name}`;
    container.appendChild(tag);
  } else {
    // Show as a select dropdown
    const label = document.createElement('span');
    label.className = 'bt-selection-provider-label';
    label.textContent = 'Model: ';
    
    const select = document.createElement('select');
    select.className = 'bt-selection-provider-select';
    
    providers.forEach(p => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      if (p.id === activeId) option.selected = true;
      select.appendChild(option);
    });
    
    container.appendChild(label);
    container.appendChild(select);
    
    return select;
  }
  return null;
}

function getLanguageName(code) {
  return i18n.t("lang." + code) || code.toUpperCase();
}

function makeDraggable(element, handle) {
  let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
  
  handle.onmousedown = dragMouseDown;

  function dragMouseDown(e) {
    e = e || window.event;
    // Only allow left click
    if (e.button !== 0) return;
    
    // Don't drag if clicking on the close button
    if (e.target.closest('.bt-selection-close')) return;

    e.preventDefault();
    
    // Convert bottom/right to top/left if needed for consistent math
    const rect = element.getBoundingClientRect();
    element.style.bottom = 'auto';
    element.style.right = 'auto';
    element.style.top = rect.top + 'px';
    element.style.left = rect.left + 'px';

    // Get the mouse cursor position at startup
    pos3 = e.clientX;
    pos4 = e.clientY;
    document.onmouseup = closeDragElement;
    // Call a function whenever the cursor moves
    document.onmousemove = elementDrag;
  }

  function elementDrag(e) {
    e = e || window.event;
    e.preventDefault();
    // Calculate the new cursor position
    pos1 = pos3 - e.clientX;
    pos2 = pos4 - e.clientY;
    pos3 = e.clientX;
    pos4 = e.clientY;
    // Set the element's new position
    element.style.top = (element.offsetTop - pos2) + "px";
    element.style.left = (element.offsetLeft - pos1) + "px";
    
    // Remove arrow class when dragged to avoid visual artifacts
    element.classList.remove('bt-popup-top', 'bt-popup-bottom');
  }

  function closeDragElement() {
    // Stop moving when mouse button is released
    document.onmouseup = null;
    document.onmousemove = null;
  }
}
// Hover translate state
let hoverModifierPressed = false;
let hoverTranslateCache = new Map();
let currentHoveredElement = null;
let hoverTimeout = null;
let lastMouseX = 0;
let lastMouseY = 0;

document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}, { passive: true });

function registerHoverTranslate() {

  
  // Track modifier key state
  document.addEventListener('keydown', async (e) => {

    
    const settings = await getSettings();

    
    if (!settings.hoverTranslateEnabled) {

      return;
    }
    
    const isOnDomain = isHoverTranslateDomain(settings);

    if (!isOnDomain) {

      return;
    }
    
    const key = settings.hoverModifierKey || 'ctrl';

    if (
      (key === 'ctrl' && e.ctrlKey) ||
      (key === 'shift' && e.shiftKey) ||
      (key === 'alt' && e.altKey)
    ) {

      hoverModifierPressed = true;
      document.body.classList.add('bt-hover-translate-active');
      
      // Apply custom styles
      applyHoverCustomStyles(settings.hoverInjectStyle);
      
      // Trigger translation or toggle if already hovering over an element
      const element = document.elementFromPoint(lastMouseX, lastMouseY);
      if (element) {
        // Check if hovering over a translation or an already translated element
        const translationEl = element.closest('.bt-hover-translation');
        const originalEl = element.closest('[data-bt-translated="true"]');
        
        if (translationEl) {
          // Hovering over translation -> Close it

          const prev = translationEl.previousElementSibling;
          if (prev && prev.dataset.btTranslated) {
            delete prev.dataset.btTranslated;
            prev.classList.remove('bt-hover-original');
          }
          translationEl.remove();
          return;
        }
        
        if (originalEl) {
          // Hovering over original that is already translated -> Close it

          const next = originalEl.nextElementSibling;
          if (next && next.classList.contains('bt-hover-translation')) {
            next.remove();
          }
          delete originalEl.dataset.btTranslated;
          originalEl.classList.remove('bt-hover-original');
          return;
        }


        const translatable = findTranslatableElement(element);
        if (translatable) {

          
          // Unique Mode: Clear all other translations if enabled
          // Note: We also check this inside handleHoverTranslate for mouseover events
          if (settings.hoverUniqueMode !== false) {
             clearAllHoverTranslations();
          }
          
          handleHoverTranslate(translatable, settings);
        }
      }
    }
  }, true);

  document.addEventListener('keyup', async (e) => {
    const settings = await getSettings();
    const key = settings.hoverModifierKey || 'ctrl';
    
    if (
      (key === 'ctrl' && !e.ctrlKey) ||
      (key === 'shift' && !e.shiftKey) ||
      (key === 'alt' && !e.altKey)
    ) {

      hoverModifierPressed = false;
      document.body.classList.remove('bt-hover-translate-active');
      // clearAllHoverTranslations(); // Don't clear on key release
    }
  }, true);

  // Hover detection with debouncing
  document.addEventListener('mouseover', async (e) => {

    
    if (!hoverModifierPressed) return;
    

    const settings = await getSettings();
    if (!isHoverTranslateDomain(settings)) {

      return;
    }
    

    clearTimeout(hoverTimeout);
    const element = findTranslatableElement(e.target);
    
    if (!element) {

      return;
    }
    if (element === currentHoveredElement) {

      return;
    }
    

    currentHoveredElement = element;
    hoverTimeout = setTimeout(() => {

      handleHoverTranslate(element, settings);
    }, 200);
  }, true);

  document.addEventListener('mouseout', () => {
    clearTimeout(hoverTimeout);
  }, true);
}

/**
 * Check if element is a translation boundary (should not traverse beyond)
 * Boundaries are containers for individual messages/content blocks on chat platforms
 */
function isTranslationBoundary(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;

  // Discord: message content divs have class containing 'messageContent' or ID starting with 'message-content-'
  const className = element.className || '';
  const id = element.id || '';

  // Check Discord patterns
  if (className.includes('messageContent') || id.startsWith('message-content-')) {
    return true;
  }

  // Slack: message blocks
  if (className.includes('p-rich_text_section') || className.includes('c-message__body')) {
    return true;
  }

  // Telegram Web: message bubbles
  if (className.includes('message-content') || className.includes('text-content')) {
    return true;
  }

  // Generic: data attributes that might indicate message boundaries
  if (element.hasAttribute('data-message-id') || element.hasAttribute('data-msg-id')) {
    return true;
  }

  return false;
}

/**
 * Find the nearest boundary ancestor (if any)
 */
function findBoundaryAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (isTranslationBoundary(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function findTranslatableElement(target) {
  let element = target;
  let depth = 0;
  const maxDepth = 5;

  // Find boundary first - we should not traverse beyond this
  const boundary = findBoundaryAncestor(target);

  while (element && depth < maxDepth) {
    // CRITICAL: If we have a boundary, never go beyond it
    // Check if current element is at or beyond the boundary
    if (boundary) {
      // If we've reached the boundary's parent, stop and return boundary
      if (element === boundary.parentElement || !boundary.contains(element)) {
        return boundary;
      }
    }

    // Ignore our own translation elements
    if (element.classList.contains('bt-hover-translation')) return null;

    // Ignore interactive elements to avoid conflict
    if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(element.tagName)) {
       // Unless it's a link with significant text, maybe? For now, skip to avoid issues.
       // Actually, users might want to translate links. Let's allow A if it has text.
       if (element.tagName !== 'A') {
         element = element.parentElement;
         depth++;
         continue;
       }
    }

    const text = element.textContent?.trim();

    if (text && text.length > 2 && text.length < 2000) { // Adjusted limits
      const tagName = element.tagName?.toLowerCase();
      // Block-level elements only (removed 'span', 'a', 'b', 'i' to prioritize containers)
      if (['div', 'p', 'article', 'section', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre'].includes(tagName)) {

        // If this element IS the boundary, return it directly (skip container checks)
        if (boundary && element === boundary) {
          return element;
        }

        // Smart check: If it's a DIV/SECTION, ensure it's not just a container of other blocks
        // We prefer "leaf" blocks or blocks with mostly text
        if (['div', 'section', 'article'].includes(tagName)) {
           const childBlockCount = element.querySelectorAll('div, p, section, article, li').length;
           // If it has too many block children, it's likely a container. Skip it unless it has direct text.
           if (childBlockCount > 3) {
             // Check if it has significant direct text
             const directText = Array.from(element.childNodes)
               .filter(n => n.nodeType === Node.TEXT_NODE)
               .map(n => n.textContent.trim())
               .join('');
             if (directText.length < 50) {
               // If this would take us beyond boundary, return boundary instead
               if (boundary && (element.parentElement === boundary.parentElement || !boundary.contains(element.parentElement))) {
                 return boundary;
               }
               element = element.parentElement;
               depth++;
               continue;
             }
           }
        }

        const textNodes = Array.from(element.childNodes).filter(
          n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
        );

        // Allow if it has text nodes OR is a small container
        if (textNodes.length > 0 || element.children.length <= 3) {
          // LIST PROMOTION: If we found a list item, select the whole list
          // BUT NOT if there's a boundary - in chat apps, each LI is a separate message
          if (['LI', 'DT', 'DD'].includes(element.tagName)) {
             // If we have a boundary ancestor, don't promote - return the boundary
             if (boundary) {
               return boundary;
             }
             return element.closest('ul, ol, dl') || element.parentElement;
          }
          return element;
        }
      }
    }

    element = element.parentElement;
    depth++;
  }

  // If we have a boundary but didn't find suitable element, return boundary
  if (boundary) {
    return boundary;
  }

  return null;
}

async function handleHoverTranslate(element, settings) {
  // Always use innerHTML to capture any potential formatting
  const text = element.innerHTML?.trim();

  if (!text) {
    return;
  }
  
  // Log parent element info for debugging
  console.log('[Hover] Target:', element.tagName, 'Granularity:', settings.hoverTranslateGranularity || 'line');

  // Get granularity setting (default: 'line')
  const granularity = settings.hoverTranslateGranularity || 'line';
  
  // Unique Mode Check (Fix: Moved inside handler to catch mouseover events)
  if (settings.hoverUniqueMode !== false) {
    clearAllHoverTranslations();
  }

  // Route to appropriate translation method based on granularity
  if (granularity === 'line') {
    return handleLineByLineTranslate(
      element, text, settings,
      createHoverPlaceholder,
      updateHoverContent,
      requestTranslation,
      hoverTranslateCache,
      clearAllHoverTranslations
    );
  } else if (granularity === 'sentence') {
    return handleSentenceBySentenceTranslate(
      element, text, settings,
      createHoverPlaceholder,
      updateHoverContent,
      requestTranslation,
      hoverTranslateCache,
      clearAllHoverTranslations
    );
  }
  
  // Default: Block mode (existing behavior)
  // Create placeholder immediately
  const placeholder = createHoverPlaceholder(element, settings);
  
  // Include providerId in cache key to support provider switching
  const cacheKey = `${text}-${settings.nativeLanguageCode}-${settings.activeProviderId}`;
  if (hoverTranslateCache.has(cacheKey)) {
    updateHoverContent(placeholder, hoverTranslateCache.get(cacheKey), settings);
    return;
  }
  
  try {
    const res = await requestTranslation({
      text: text,
      nativeLanguageCode: settings.nativeLanguageCode || "en",
      targetLanguage: settings.nativeLanguageCode || "vi", // Translate TO native language
      sourceLanguage: settings.targetLanguageCode || "en", // FROM target language (e.g., English web content)
      useAutoDetect: false // Fixed Target→Native for hover
    });
    
    if (res?.ok && res.result?.translation) {
      const translation = res.result.translation;
      hoverTranslateCache.set(cacheKey, translation);
      updateHoverContent(placeholder, translation, settings);
    } else {
      // Show error inline instead of removing
      updateHoverContent(placeholder, `❌ ${res?.error || 'Translation failed'}`, settings, true);
    }
  } catch (err) {
    // Show error inline instead of removing
    updateHoverContent(placeholder, `❌ ${err.message || 'Error'}`, settings, true);
  }
}

function createHoverPlaceholder(element, settings) {
  // Check if already exists
  let existing = element.nextElementSibling;
  if (existing && existing.classList.contains('bt-hover-translation')) {
    return existing;
  }

  // Create element of the same tag to mimic structure
  const translationEl = document.createElement(element.tagName);
  translationEl.className = 'bt-hover-translation';
  translationEl.style.userSelect = 'none';
  translationEl.style.webkitUserSelect = 'none';
  
  // Copy styles from original element to look like a clone
  const computedStyle = window.getComputedStyle(element);
  
  // Copy text styles
  translationEl.style.fontFamily = computedStyle.fontFamily;
  translationEl.style.fontSize = settings.hoverInjectStyle?.fontSize || computedStyle.fontSize;
  translationEl.style.fontWeight = computedStyle.fontWeight;
  translationEl.style.fontStyle = computedStyle.fontStyle;
  translationEl.style.lineHeight = computedStyle.lineHeight;
  translationEl.style.textAlign = computedStyle.textAlign;
  translationEl.style.letterSpacing = computedStyle.letterSpacing;
  
  // Color Logic:
  // Always transparent background.
  // Use user's textColor (default Red #ff0000).
  translationEl.style.backgroundColor = 'transparent';
  translationEl.style.color = settings.hoverInjectStyle?.textColor || '#ff0000';
  
  // Copy layout styles
  translationEl.style.padding = computedStyle.padding;
  translationEl.style.margin = computedStyle.margin;
  translationEl.style.marginTop = '4px'; // Add slight separation
  translationEl.style.width = computedStyle.width !== 'auto' ? computedStyle.width : '100%';
  translationEl.style.boxSizing = 'border-box';
  
  // Ensure block display for proper positioning below
  translationEl.style.display = 'block';
  
  const style = settings.hoverInjectStyle || {};
  if (style.underline) {
    translationEl.classList.add('bt-hover-underline');
  }
  
  // RAT-FIX: icon injection removed (never inject chrome-extension images into page DOM)

  // Add modern CSS spinner instead of GIF
  const loadingSpinner = document.createElement('span');
  loadingSpinner.className = 'bt-spinner';
  translationEl.appendChild(loadingSpinner);
  
  translationEl.dataset.btInjected = 'true';
  
  // Ensure original element handles the insertion correctly
  // if (computedStyle.display === 'inline') {
  //   element.style.display = 'inline-block';
  // }
  
  (function(el, holder){ try { const ed = el && (el.isContentEditable || (el.closest && el.closest('[contenteditable="true"], .sceditor-container, .cke_editable, .ql-editor, .fr-element'))); if (!ed) el.insertAdjacentElement('afterend', holder); else holder.dataset.btDetached = '1'; } catch(e) { try { element.insertAdjacentElement('afterend', holder); } catch(_) {} } })(element, translationEl);
  // element.classList.add('bt-hover-original'); // Keep natural
  
  return translationEl;
}

function updateHoverContent(element, translation, settings, isError = false) {
  // Keep the TransKit icon
  const icon = element.querySelector('.bt-hover-icon');
  
  element.innerHTML = ''; // Clear content
  if (icon) element.appendChild(icon);
  
  // Append translation text safely to prevent XSS
  const textSpan = document.createElement('span');
  textSpan.textContent = translation;
  element.appendChild(textSpan);
  
  // Apply error styling if needed
  if (isError) {
    element.style.color = '#dc3545'; // text-danger red
    element.style.fontWeight = 'bold';
  }
  
  // Model Label removed as per user request
}

function applyHoverTranslation(element, translation, settings) {
  console.log('[HoverTranslate] applyHoverTranslation called, mode:', settings.hoverTranslateMode);
  if (element.dataset.btTranslated) {
    console.log('[HoverTranslate] Element already translated');
    return;
  }
  element.dataset.btTranslated = 'true';
  
  const mode = settings.hoverTranslateMode || 'inject';
  
  if (mode === 'replace') {
    console.log('[HoverTranslate] Applying replace mode');
    applyReplaceMode(element, translation);
  } else {
    console.log('[HoverTranslate] Applying inject mode');
    applyInjectMode(element, translation, settings);
  }
  console.log('[HoverTranslate] Translation applied successfully');
}

function applyReplaceMode(element, translation) {
  if (!element.dataset.btOriginal) {
    element.dataset.btOriginal = element.textContent;
  }
  
  replaceTextContent(element, translation);
  element.classList.add('bt-hover-translated');
}

function applyInjectMode(element, translation, settings) {
  // Create element of the same tag to mimic structure
  const translationEl = document.createElement(element.tagName);
  translationEl.className = 'bt-hover-translation';
  translationEl.style.userSelect = 'none';
  translationEl.style.webkitUserSelect = 'none';
  
  // Copy styles from original element to look like a clone
  const computedStyle = window.getComputedStyle(element);
  
  // Copy text styles
  translationEl.style.fontFamily = computedStyle.fontFamily;
  translationEl.style.fontSize = settings.hoverInjectStyle?.fontSize || computedStyle.fontSize;
  translationEl.style.fontWeight = computedStyle.fontWeight;
  translationEl.style.fontStyle = computedStyle.fontStyle;
  translationEl.style.lineHeight = computedStyle.lineHeight;
  translationEl.style.textAlign = computedStyle.textAlign;
  translationEl.style.letterSpacing = computedStyle.letterSpacing;
  translationEl.style.color = settings.hoverInjectStyle?.textColor || computedStyle.color;
  
  // Copy layout styles
  translationEl.style.padding = computedStyle.padding;
  translationEl.style.margin = computedStyle.margin;
  translationEl.style.marginTop = '4px'; // Add slight separation
  translationEl.style.width = computedStyle.width !== 'auto' ? computedStyle.width : '100%';
  translationEl.style.boxSizing = 'border-box';
  translationEl.style.backgroundColor = settings.hoverInjectStyle?.backgroundColor || 'transparent';
  
  // Ensure block display for proper positioning below
  translationEl.style.display = 'block';
  
  const style = settings.hoverInjectStyle || {};
  
  if (!style.showIcon) {
    translationEl.classList.add('bt-hover-no-icon');
  }
  if (style.underline) {
    translationEl.classList.add('bt-hover-underline');
  }
  
  translationEl.textContent = translation;
  translationEl.dataset.btInjected = 'true';
  
  // Ensure original element handles the insertion correctly
  if (computedStyle.display === 'inline') {
    element.style.display = 'inline-block';
  }
  
  (function(el, holder){ try { const ed = el && (el.isContentEditable || (el.closest && el.closest('[contenteditable="true"], .sceditor-container, .cke_editable, .ql-editor, .fr-element'))); if (!ed) el.insertAdjacentElement('afterend', holder); else holder.dataset.btDetached = '1'; } catch(e) { try { element.insertAdjacentElement('afterend', holder); } catch(_) {} } })(element, translationEl);
  element.classList.add('bt-hover-original');
}

function replaceTextContent(element, newText) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }
  
  if (textNodes.length > 0) {
    textNodes[0].textContent = newText;
    textNodes.slice(1).forEach(node => node.remove());
  }
}

function clearAllHoverTranslations() {
  // 1. Remove standard block translations
  document.querySelectorAll('.bt-hover-translation').forEach(el => el.remove());
  
  // 2. Remove node-based injected content (Legacy)
  document.querySelectorAll('.bt-injected-content').forEach(el => el.remove());
  
  // 3. Cleanup Wrappers (Unwrap)
  document.querySelectorAll('[data-transkit-wrapper]').forEach(wrapper => {
    const originalSpan = wrapper.querySelector('[data-transkit-original]');
    if (originalSpan) {
      // Move original text nodes back to parent
      while (originalSpan.firstChild) {
        wrapper.parentNode.insertBefore(originalSpan.firstChild, wrapper);
      }
    }
    wrapper.remove();
  });
  
  // 4. Cleanup original elements (Block mode replace)
  document.querySelectorAll('[data-bt-original]').forEach(el => {
    replaceTextContent(el, el.dataset.btOriginal);
    delete el.dataset.btOriginal;
    delete el.dataset.btTranslated;
    el.classList.remove('bt-hover-translated');
  });
  
  // 5. Cleanup granular mode markers
  document.querySelectorAll('[data-transkit-translated]').forEach(el => {
    el.removeAttribute('data-transkit-translated');
    el.classList.remove('bt-hover-translated');
  });
  
  currentHoveredElement = null;
}

function isHoverTranslateDomain(settings) {
  if (!settings.hoverTranslateEnabled) return false;

  // All-sites model: empty list means every site; listed sites are opt-out.
  const list = settings.hoverTranslateDomains;
  if (!Array.isArray(list) || list.length === 0) return true;

  const host = window.location.hostname;
  const excluded = list.some(
    (d) => d && d.enabled !== false && hostMatchesPattern(host, d.domain)
  );
  return !excluded;
}

function applyHoverCustomStyles(style) {
  const root = document.documentElement;
  root.style.setProperty('--bt-hover-bg-color', style.backgroundColor || '#667eea');
  root.style.setProperty('--bt-hover-text-color', style.textColor || '#ffffff');
  root.style.setProperty('--bt-hover-font-size', style.fontSize || '0.95em');
  root.style.setProperty('--bt-hover-show-icon', style.showIcon !== false ? 'inline' : 'none');
}

function registerHoverToggleShortcut() {
  document.addEventListener('keydown', async (e) => {
    const settings = await getSettings();
    const shortcut = settings.hoverToggleShortcut || {
      key: "O",
      ctrl: true,
      shift: true,
      alt: false
    };

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifierKey = isMac ? e.metaKey : e.ctrlKey;

    const matches =
      e.key.toUpperCase() === shortcut.key.toUpperCase() &&
      modifierKey === shortcut.ctrl &&
      e.shiftKey === shortcut.shift &&
      e.altKey === shortcut.alt;

    if (matches) {
      e.preventDefault();
      e.stopPropagation();
      await toggleHoverDomainForCurrentUrl();
    }
  }, true);
}

async function toggleHoverDomainForCurrentUrl() {
  try {
    const settings = await getSettings();
    const currentUrl = window.location.href;

    if (!settings.hoverTranslateDomains) {
      settings.hoverTranslateDomains = [];
    }

    const matchingDomainIndex = settings.hoverTranslateDomains.findIndex(
      d => currentUrl.includes(d.domain)
    );

    // If global setting is disabled, enable it and FORCE enable the domain
    if (!settings.hoverTranslateEnabled) {
      settings.hoverTranslateEnabled = true;
      
      if (matchingDomainIndex !== -1) {
        // Force enable if it exists
        settings.hoverTranslateDomains[matchingDomainIndex].enabled = true;
      }
      // If it doesn't exist, it will be added below
    } else if (matchingDomainIndex !== -1) {
      // Global is already on, so we just toggle the domain
      settings.hoverTranslateDomains[matchingDomainIndex].enabled = !settings.hoverTranslateDomains[matchingDomainIndex].enabled;
    }

    if (matchingDomainIndex === -1) {
      // Auto-add domain
      const domain = extractDomainFromUrl(currentUrl);
      
      settings.hoverTranslateDomains.push({
        domain: domain,
        enabled: true
      });
      
      try {
        await safeRuntimeCall(() => chrome.runtime.sendMessage({
          type: "set-settings",
          settings: settings
        }));
      } catch (error) {
        console.log('TransKit: Error saving hover domain settings:', error.message);
        return;
      }
      
      showToastBottomRight(`✨ Hover translate enabled for ${domain}`);
      return;
    }

    // Get the domain object
    const domain = settings.hoverTranslateDomains[matchingDomainIndex];

    try {
      await safeRuntimeCall(() => chrome.runtime.sendMessage({
        type: "set-settings",
        settings: settings
      }));
    } catch (error) {
      console.log('TransKit: Error updating hover domain settings:', error.message);
      return;
    }

    const status = domain.enabled
      ? "✨ Hover translate enabled"
      : "Hover translate disabled";

    showToastBottomRight(`${status} for ${domain.domain}`);

    if (!domain.enabled) {
      clearAllHoverTranslations();
    }
  } catch (err) {
    console.error("Toggle hover domain error:", err);
    showToast("Error toggling hover domain");
  }
}


// Global protection: prevent TransKit translation and UI elements from polluting user copy/clipboard
document.addEventListener("copy", (e) => {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    // Check if selection intersects any TransKit UI or hover elements
    const transkitSelectors = '.bt-hover-translation, .bt-inline-suggestion, .bt-selection-icon, .bt-selection-popup, .bt-toast-notify, [data-transkit-translation="true"]';
    const hasTranskitElements = document.querySelector(transkitSelectors);
    if (!hasTranskitElements) return;

    // Clone selection contents into a temporary fragment
    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    
    // Check if fragment contains any transkit elements
    const elementsToRemove = fragment.querySelectorAll(transkitSelectors);
    if (elementsToRemove.length > 0) {
      elementsToRemove.forEach(el => el.remove());
      const cleanText = fragment.textContent || "";
      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", cleanText);
        e.preventDefault();
      }
    }
  } catch (err) {
    // Fail silently to avoid breaking native copy
  }
}, true);
