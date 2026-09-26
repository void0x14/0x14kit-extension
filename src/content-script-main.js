/**
 * TransKit MAIN-world bridge.
 *
 * Model-driven editors (Lexical, ProseMirror, Quill, CKEditor) ignore edits
 * performed from the extension's isolated world, and an activeElement-based
 * exec can lose the element identity when the editor re-renders. This tiny
 * script runs in the page's MAIN world: the isolated content script dispatches
 * a CustomEvent ON the target element, so event.target is the exact element
 * (identity preserved, shadow DOM included).
 *
 * The replacement mimics exactly what a human does — focus, select all, wait
 * one macrotask for the editor's selectionchange sync, then paste — so it goes
 * through each editor's own paste pipeline (the one path every editor handles
 * correctly, including full-selection replacement).
 */
(function () {
  if (window.__transkitMainBridge) return;
  window.__transkitMainBridge = true;

  window.addEventListener("__transkitPageExec", function (e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;

    var detail = e.detail || {};
    var text = String(detail.text ? detail.text : "");

    (async function () {
      var ok = false;
      var reason = "";
      try {
        el.focus();
        if (document.activeElement !== el) {
          reason = "focus-lost";
        } else {
          document.execCommand("selectAll", false, null);
          // Let the editor's selectionchange handler sync its model selection
          // to the fresh full-range DOM selection before the paste lands.
          await new Promise(function (r) { setTimeout(r, 0); });
          var dt = new DataTransfer();
          dt.setData("text/plain", text);
          el.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: dt
          }));
          // Give model editors one task to reconcile the paste.
          await new Promise(function (r) { setTimeout(r, 0); });
          var norm = function (s) { return String(s || "").replace(/\s+/g, " "); };
          ok = norm(el.innerText || el.value).indexOf(norm(text).trim().slice(0, 40)) !== -1;
          if (!ok) {
            // Fallback: controlled insertText replace in the same synced state
            document.execCommand("selectAll", false, null);
            await new Promise(function (r) { setTimeout(r, 0); });
            ok = document.execCommand("insertText", false, text);
          }
          if (!ok) reason = "insert-failed";
        }
      } catch (err) {
        reason = String(err && err.message ? err.message : err);
      }

      try {
        el.dispatchEvent(
          new CustomEvent("__transkitPageExecResult", {
            bubbles: true,
            detail: { nonce: detail.nonce, ok: !!ok, reason: reason }
          })
        );
      } catch (err) {}
    })();
  });
})();
