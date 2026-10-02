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
const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
const byText = (selector, pattern) => all(selector).find((el) => pattern.test((el.textContent || el.getAttribute("aria-label") || "").trim()));

function findComposeButton() {
  return document.querySelector('[data-testid*="compose" i], [aria-label*="compose" i]') || byText('button, [role="button"]', /^(compose|new message|new email)$/i);
}

function findField(kind) {
  const selectors = {
    to: ['input[autocomplete="email"]', 'input[name="to"]', 'input[aria-label*="to" i]', 'input[placeholder*="recipient" i]', '[contenteditable="true"][aria-label*="to" i]'],
    subject: ['input[name="subject"]', 'input[aria-label*="subject" i]', 'input[placeholder*="subject" i]'],
    body: ['[contenteditable="true"][aria-label*="message" i]', '[contenteditable="true"][role="textbox"]', 'textarea[aria-label*="message" i]', 'textarea[name="body"]']
  };
  for (const selector of selectors[kind]) {
    const match = all(selector)[0];
    if (match) return match;
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
  throw new Error(`Could not find the ${kind} field. Private Email may have changed its layout.`);
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
