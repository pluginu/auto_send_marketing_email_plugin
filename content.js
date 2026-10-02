const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function findField(kind) {
  const root = findComposeRoot();
  const selectors = {
    to: ['input[autocomplete="email"]', 'input[name="to"]', 'input[id*="to" i]', 'input[aria-label*="to" i]', 'input[placeholder*="recipient" i]', '[contenteditable="true"][aria-label*="to" i]'],
    subject: ['input[name="subject"]', 'input[id*="subject" i]', 'input[aria-label*="subject" i]', 'input[placeholder*="subject" i]'],
    body: ['[contenteditable="true"][aria-label*="message" i]', '[contenteditable="true"][data-placeholder*="message" i]', 'textarea[aria-label*="message" i]', 'textarea[name="body"]']
  };
  for (const selector of selectors[kind]) {
    const match = all(selector, root)[0];
    if (match) return match;
  }
  if (kind === "to") return fieldBesideLabel(/^to:?$/i, root);
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

function setValue(element, value) {
  element.focus();
  if (element.isContentEditable) {
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  } else {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
    setter ? setter.call(element, value) : (element.value = value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

async function waitForField(kind, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const field = findField(kind);
    if (field) return field;
    await sleep(150);
  }
  const root = findComposeRoot();
  const controls = all('input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]', root).length;
  throw new Error(`Could not find the ${kind} field (${controls} editable controls detected). Refresh Private Email after reloading the extension.`);
}

async function compose({ to, subject, body, send = false }) {
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
  setValue(subjectField, subject);
  setValue(bodyField, body);

  if (send) {
    await sleep(500);
    const sendButton = document.querySelector('[data-testid*="send" i], [aria-label^="send" i]') || byText('button, [role="button"]', /^send$/i);
    if (!sendButton) throw new Error("Draft was filled, but the Send button was not found.");
    sendButton.click();
  }
  return { ok: true, sent: send };
}
