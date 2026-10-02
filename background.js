const DEFAULTS = {
  settings: {
    model: "gpt-4o-mini",
    senderName: "",
    company: "SIN",
    offer: "",
    tone: "Warm, concise, professional",
    callToAction: "Ask for a short introductory call",
    minPause: 20,
    maxPause: 45,
    autoSend: false
  },
  contacts: [],
  queue: []
};

const MAX_LOG_ENTRIES = 1000;
// Serialize storage updates so simultaneous events cannot overwrite one another.
let logWrite = Promise.resolve();

function safeDetails(details = {}) {
  // Diagnostic exports must never include credentials or unbounded editor content.
  const clean = {};
  for (const [key, value] of Object.entries(details)) {
    if (/api.?key|authorization|token/i.test(key)) continue;
    clean[key] = typeof value === "string" && value.length > 1000 ? `${value.slice(0, 1000)}…` : value;
  }
  return clean;
}

function appendLog(level, event, details = {}) {
  const entry = { timestamp: new Date().toISOString(), level, event, details: safeDetails(details) };
  logWrite = logWrite.then(async () => {
    const { diagnosticLogs = [] } = await chrome.storage.local.get("diagnosticLogs");
    diagnosticLogs.push(entry);
    await chrome.storage.local.set({ diagnosticLogs: diagnosticLogs.slice(-MAX_LOG_ENTRIES) });
  }).catch(() => {});
  return logWrite;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const next = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) next[key] = value;
  }
  if (Object.keys(next).length) await chrome.storage.local.set(next);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  if (reason === "update") {
    // Reload open mail tabs so they immediately receive the updated content script.
    const tabs = await chrome.tabs.query({ url: "https://privateemail.com/*" });
    await Promise.allSettled(tabs.map((tab) => chrome.tabs.reload(tab.id)));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "LOG_EVENT") {
    appendLog(message.level || "info", message.event || "unknown", message.details).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type !== "GENERATE_EMAIL") return false;
  appendLog("info", "draft_generation_started", { contactId: message.payload?.contact?.id, email: message.payload?.contact?.email, model: message.payload?.settings?.model });
  generateEmail(message.payload)
    .then((draft) => {
      appendLog("info", "draft_generation_completed", { contactId: message.payload?.contact?.id, subjectLength: draft.subject?.length || 0, bodyLength: draft.body?.length || 0 });
      sendResponse({ ok: true, draft });
    })
    .catch((error) => {
      appendLog("error", "draft_generation_failed", { contactId: message.payload?.contact?.id, error: error.message });
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

async function generateEmail({ contact, settings }) {
  const { openaiApiKey } = await chrome.storage.local.get("openaiApiKey");
  if (!openaiApiKey) throw new Error("Add your OpenAI API key in Settings first.");

  const details = {
    name: contact.name || "",
    email: contact.email,
    company: contact.company || "",
    role: contact.role || "",
    persona: contact.persona || "",
    interests: contact.interests || "",
    problem: contact.problem || "",
    notes: contact.notes || "",
    profile_url: contact.profileUrl || "",
    source_site: contact.site || "",
    phone: contact.phone || "",
    social_platforms: contact.socialPlatforms || "",
    additional_profile_data: contact.extra || {}
  };
  const prompt = `Write a one-to-one B2B sales email using only supported facts below. Never invent facts, achievements, relationships, or research. Avoid spammy language, pressure, and exaggerated claims. Keep the body under 140 words, plain text, and include a natural greeting and sign-off.\n\nSender name: ${settings.senderName || "the sender"}\nSender company: ${settings.company || "SIN"}\nOffer: ${settings.offer || "Not specified; make the message exploratory"}\nTone: ${settings.tone}\nCall to action: ${settings.callToAction}\nRecipient JSON: ${JSON.stringify(details)}`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify({
      model: settings.model || "gpt-4o-mini",
      store: false,
      input: [
        { role: "system", content: "You create accurate, respectful, permission-based sales emails. Return the requested JSON only." },
        { role: "user", content: prompt }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "sales_email",
          strict: true,
          schema: {
            type: "object",
            properties: {
              subject: { type: "string" },
              body: { type: "string" }
            },
            required: ["subject", "body"],
            additionalProperties: false
          }
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI request failed (${response.status}).`);
  const text = data.output?.flatMap((item) => item.content || []).find((item) => item.type === "output_text")?.text;
  if (!text) throw new Error("OpenAI returned no email text.");
  try {
    const draft = JSON.parse(text);
    if (!draft.subject?.trim() || !draft.body?.trim()) throw new Error("OpenAI returned a draft with an empty subject or body.");
    return draft;
  } catch (error) {
    if (/empty subject or body/.test(error.message)) throw error;
    throw new Error("OpenAI returned an unreadable draft.");
  }
}
