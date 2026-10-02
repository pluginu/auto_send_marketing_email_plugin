const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (level, event, details = {}) => chrome.runtime.sendMessage({ type: "LOG_EVENT", level, event, details }).catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "PRIVATE_EMAIL_PING") {
    sendResponse({ ok: true, url: location.href, composeFound: Boolean(findComposeButton()) });
    return false;
  }
  if (message.type === "PRIVATE_EMAIL_COMPOSE") {
    compose(message.payload).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});

const visible = (el) => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
const byText = (selector, pattern, root = document) => all(selector, root).find((el) => pattern.test((el.textContent || el.getAttribute("aria-label") || "").trim()));

function findComposeButton() {
  return document.querySelector('[data-testid*="compose" i], [aria-label*="compose" i]') || byText('button, [role="button"]', /^(compose|new message|new email)$/i);
}

function findComposeRoot() {
  const dialogs = all('[role="dialog"], [aria-modal="true"]');
  return dialogs.find((dialog) => /compose email/i.test(dialog.textContent || ""))
    || dialogs.find((dialog) => byText('button, [role="button"]', /^send$/i, dialog))
    || document;
}

function accessibleDocuments(root = document, found = []) {
  // The message editor may live in a same-origin iframe; cross-origin frames are skipped.
  if (found.includes(root)) return found;
  found.push(root);
  for (const frame of root.querySelectorAll("iframe")) {
    try { if (frame.contentDocument) accessibleDocuments(frame.contentDocument, found); } catch (_) {}
  }
  return found;
}

function findLabel(pattern, root) {
  return all('label, span, div, td', root)
    .filter((el) => pattern.test((el.textContent || "").trim()))
    .sort((a, b) => a.children.length - b.children.length)[0];
}

function fieldBesideLabel(pattern, root) {
  const label = findLabel(pattern, root);
  if (!label) return null;
  const labelBox = label.getBoundingClientRect();
  const candidates = all('input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]', root)
    .filter((el) => !el.disabled && !el.readOnly);
  return candidates
    .map((el) => {
      const box = el.getBoundingClientRect();
      const vertical = Math.abs((box.top + box.height / 2) - (labelBox.top + labelBox.height / 2));
      const leftPenalty = box.right < labelBox.right ? 500 : 0;
      return { el, score: vertical + leftPenalty };
    })
    .filter((entry) => entry.score < 90)
    .sort((a, b) => a.score - b.score)[0]?.el || null;
}

function editableControls(root) {
  return all('input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]', root)
    .filter((el) => !el.disabled && !el.readOnly);
}

function controlText(element) {
  return [element.getAttribute("aria-label"), element.getAttribute("placeholder"), element.getAttribute("name"), element.id, element.getAttribute("data-placeholder"), element.getAttribute("autocomplete")]
    .filter(Boolean).join(" ").toLowerCase();
}

function controlContext(element) {
  const parts = [controlText(element)];
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
    parts.push(
      parent.id,
      typeof parent.className === "string" ? parent.className : "",
      parent.getAttribute("aria-label"),
      parent.getAttribute("data-name"),
      parent.getAttribute("data-field"),
      parent.getAttribute("data-extension-id")
    );
    const label = [...parent.children].find((child) => child !== element && /^(to|subject):?$/i.test((child.textContent || "").trim()));
    if (label) parts.push(label.textContent);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function findRecipientByLayout(root) {
  // Private Email's generated class names can change, so use nearby labels and geometry as a fallback.
  const controls = editableControls(root);
  const subject = controls.find((el) => /\bsubject\b/.test(controlContext(el)));
  const contextual = controls.filter((el) => {
    const text = controlContext(el);
    return /(^|[\s_-])(to|recipient|recipients)([\s_-]|$)/.test(text)
      && !/\b(from|cc|bcc|subject|search|message|body|content)\b/.test(text)
      && el.getBoundingClientRect().height <= 100;
  });
  if (contextual.length) return contextual.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  if (!subject) return null;
  const subjectBox = subject?.getBoundingClientRect();
  const candidates = controls.filter((el) => {
    if (el === subject) return false;
    const text = controlContext(el);
    if (/search|subject|message|body|content/.test(text)) return false;
    const box = el.getBoundingClientRect();
    if (box.height > 100) return false;
    return box.bottom <= subjectBox.bottom + 8;
  });
  return candidates.map((el) => {
    const box = el.getBoundingClientRect();
    const text = controlContext(el);
    let score = Math.abs(subjectBox.top - box.top);
    if (/\b(to|recipient|address|email)\b/.test(text)) score -= 1000;
    if (el.getAttribute("role") === "combobox") score -= 100;
    if (subjectBox && box.right < subjectBox.left) score += 500;
    return { el, score };
  }).sort((a, b) => a.score - b.score)[0]?.el || null;
}

function findField(kind) {
  const root = findComposeRoot();
  const selectors = {
    to: ['input[autocomplete="email"]', 'input[name="to"]', 'input[id*="to" i]', 'input[aria-label*="recipient" i]', 'input[aria-label^="to" i]', 'input[placeholder*="recipient" i]', 'input[placeholder^="to" i]', '[role="combobox"][aria-label*="to" i]', '[contenteditable="true"][aria-label*="to" i]', '[contenteditable="true"][data-placeholder*="recipient" i]', '[data-field="to" i] input', '[data-name="to" i] input', '[data-extension-id*="to" i] input', '.recipient input', '.recipients input', '.to input'],
    subject: ['input[name="subject"]', 'input[id*="subject" i]', 'input[aria-label*="subject" i]', 'input[placeholder*="subject" i]'],
    body: ['[contenteditable="true"][aria-label*="message" i]', '[contenteditable="true"][data-placeholder*="message" i]', 'textarea[aria-label*="message" i]', 'textarea[name="body"]']
  };
  for (const selector of selectors[kind]) {
    const match = all(selector, root)[0];
    if (match) return match;
  }
  if (kind === "body") {
    for (const doc of accessibleDocuments()) {
      if (doc === document) continue;
      const match = all('body[contenteditable="true"], [contenteditable="true"], textarea, [role="textbox"]', doc)[0];
      if (match) return match;
    }
  }
  if (kind === "to") return fieldBesideLabel(/^to:?$/i, root) || findRecipientByLayout(root);
  if (kind === "subject") return fieldBesideLabel(/^subject:?$/i, root);
  if (kind === "body") {
    const subject = findLabel(/^subject:?$/i, root);
    const subjectBottom = subject?.getBoundingClientRect().bottom || 0;
    return all('[contenteditable="true"], [role="textbox"], textarea', root)
      .filter((el) => el.getBoundingClientRect().top > subjectBottom + 20)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      })[0] || null;
  }
  return null;
}

function readValue(element) {
  return (element.isContentEditable ? element.innerText || element.textContent : element.value || "").replace(/\u00a0/g, " ").trim();
}

function normalized(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function verifyValue(kind, element, expected) {
  // A visible editor can silently reject scripted input; never send unless it retained the full draft.
  const actual = readValue(element);
  const actualNormalized = normalized(actual);
  const expectedNormalized = normalized(expected);
  if (!actualNormalized) throw new Error(`Private Email did not retain the ${kind}. Nothing was sent.`);
  if (!actualNormalized.includes(expectedNormalized)) {
    throw new Error(`Private Email did not retain the complete ${kind}. Nothing was sent.`);
  }
  return actual;
}

function setValue(element, value) {
  element.focus();
  if (element.isContentEditable) {
    // insertText follows the editor's normal input path more reliably than assigning textContent alone.
    const doc = element.ownerDocument;
    const selection = doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try { inserted = doc.execCommand("insertText", false, value); } catch (_) {}
    if (!inserted || !readValue(element)) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter ? setter.call(element, value) : (element.value = value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

async function setAndVerify(kind, element, value) {
  if (!String(value || "").trim()) throw new Error(`Refusing to prepare an email with an empty ${kind}.`);
  setValue(element, value);
  element.dispatchEvent(new Event("blur", { bubbles: true }));
  await sleep(250);
  return verifyValue(kind, element, value);
}

async function waitForField(kind, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const field = findField(kind);
    if (field) return field;
    await sleep(150);
  }
  const root = findComposeRoot();
  const controls = editableControls(root);
  await log("error", "field_not_found", { kind, controls: controls.map((el) => ({ tag: el.tagName, role: el.getAttribute("role") || "", type: el.getAttribute("type") || "", descriptor: controlContext(el).slice(0, 240), top: Math.round(el.getBoundingClientRect().top), width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) })) });
  throw new Error(`Could not identify the ${kind} field (${controls.length} editable controls detected). Nothing was sent; export the Diagnostic log if this continues.`);
}

async function compose({ to, subject, body, send = false }) {
  await log("info", "compose_started", { to, subjectLength: subject?.length || 0, bodyLength: body?.length || 0, send, frameUrl: location.href });
  if (!body?.trim()) throw new Error("The generated draft body is empty. Nothing was sent.");
  try {
  let toField = findField("to");
  if (!toField) {
    const button = findComposeButton();
    if (!button) throw new Error("Compose button not found. Open the Private Email inbox and try again.");
    button.click();
    toField = await waitForField("to");
  }
  const subjectField = await waitForField("subject");
  const bodyField = await waitForField("body");
  setValue(toField, to);
  toField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  toField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  await setAndVerify("subject", subjectField, subject);
  const verifiedBody = await setAndVerify("body", bodyField, body);
  await log("info", "compose_verified", { to, subjectLength: readValue(subjectField).length, bodyLength: verifiedBody.length, bodyTag: bodyField.tagName, bodyContentEditable: bodyField.isContentEditable });

  if (send) {
    await sleep(500);
    verifyValue("body", bodyField, body);
    const sendButton = document.querySelector('[data-testid*="send" i], [aria-label^="send" i]') || byText('button, [role="button"]', /^send$/i);
    if (!sendButton) throw new Error("Draft was filled, but the Send button was not found.");
    sendButton.click();
    await log("info", "send_clicked", { to, bodyLength: readValue(bodyField).length });
  }
  return { ok: true, sent: send };
  } catch (error) {
    await log("error", "compose_failed", { to, send, error: error.message, editableControls: accessibleDocuments().reduce((count, doc) => count + doc.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]').length, 0) });
    throw error;
  }
}
