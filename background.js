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

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const next = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (current[key] === undefined) next[key] = value;
  }
  if (Object.keys(next).length) await chrome.storage.local.set(next);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GENERATE_EMAIL") return false;
  generateEmail(message.payload)
    .then((draft) => sendResponse({ ok: true, draft }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
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
  try { return JSON.parse(text); } catch { throw new Error("OpenAI returned an unreadable draft."); }
}
