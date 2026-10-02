const $ = (id) => document.getElementById(id);
let state = { contacts: [], queue: [], settings: {} };
let running = false;
const logEvent = (level, event, details = {}) => chrome.runtime.sendMessage({ type: "LOG_EVENT", level, event, details }).catch(() => {});

document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll(".tab,.panel").forEach((el) => el.classList.remove("active"));
  button.classList.add("active");
  $(button.dataset.tab).classList.add("active");
}));

async function init() {
  $("build").textContent = `v${chrome.runtime.getManifest().version}`;
  const stored = await chrome.storage.local.get(["contacts", "queue", "settings", "openaiApiKey"]);
  state.contacts = stored.contacts || [];
  state.queue = stored.queue || [];
  state.settings = stored.settings || {};
  $("apiKey").value = stored.openaiApiKey || "";
  for (const id of ["model","senderName","company","tone","offer","callToAction","minPause","maxPause"]) {
    if (state.settings[id] !== undefined) $(id).value = state.settings[id];
  }
  $("autoSend").checked = Boolean(state.settings.autoSend);
  render();
  await refreshLogs();
  await testConnection();
}

function status(message, error = false) { $("status").textContent = message; $("status").className = `status${error ? " error" : ""}`; }

async function saveSettings() {
  state.settings = {
    ...state.settings,
    model: $("model").value.trim() || "gpt-4o-mini",
    senderName: $("senderName").value.trim(), company: $("company").value.trim(), tone: $("tone").value.trim(),
    offer: $("offer").value.trim(), callToAction: $("callToAction").value.trim(),
    minPause: Math.max(10, Number($("minPause").value) || 20), maxPause: Math.max(10, Number($("maxPause").value) || 45),
    autoSend: $("autoSend").checked
  };
  if (state.settings.maxPause < state.settings.minPause) state.settings.maxPause = state.settings.minPause;
  await chrome.storage.local.set({ settings: state.settings, openaiApiKey: $("apiKey").value.trim() });
  status("Settings saved.");
}

function normalizeHeader(value) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); }
function firstValue(row, keys) { for (const key of keys) if ((row[key] || "").trim()) return row[key].trim(); return ""; }
function firstEmail(value) { return (value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [""])[0].toLowerCase(); }

function parseCsv(text) {
  const rows=[]; let row=[], cell="", quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(c==='"'&&quoted&&n==='"'){cell+='"';i++;}else if(c==='"'){quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell="";}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&n==='\n')i++;row.push(cell);if(row.some(v=>v.trim()))rows.push(row);row=[];cell="";}else cell+=c;} row.push(cell);if(row.some(v=>v.trim()))rows.push(row);
  if (rows.length < 2) throw new Error("CSV must include a header row and at least one contact.");
  const headers=rows.shift().map(normalizeHeader);
  const emailHeaders=["email","email_address","email_addresses","contact_email","customer_email"];
  if (!headers.some(header=>emailHeaders.includes(header))) throw new Error("CSV needs an email or email_addresses column.");
  const mapped=rows.map(values=>Object.fromEntries(headers.map((h,i)=>[h,(values[i]||"").trim()])));
  const contacts=[]; const seen=new Set(); let missingEmail=0,duplicates=0;
  for(const raw of mapped){
    const email=firstEmail(firstValue(raw,emailHeaders));
    if(!email){missingEmail++;continue;} if(seen.has(email)){duplicates++;continue;} seen.add(email);
    const known=new Set([...emailHeaders,"name","full_name","profile_name","company","company_name","organization","role","job_title","title","persona","interests","interest","problem","pain_point","pain_points","notes","profile_url","url","site","source_site","phone","phone_number","phone_numbers","social_platforms"]);
    const extra=Object.fromEntries(Object.entries(raw).filter(([key,value])=>value&&!known.has(key)));
    contacts.push({id:`${Date.now()}-${contacts.length}`,email,name:firstValue(raw,["name","full_name","profile_name"]),company:firstValue(raw,["company","company_name","organization"]),role:firstValue(raw,["role","job_title","title"]),persona:firstValue(raw,["persona"]),interests:firstValue(raw,["interests","interest"]),problem:firstValue(raw,["problem","pain_point","pain_points"]),notes:firstValue(raw,["notes"]),profileUrl:firstValue(raw,["profile_url","url"]),site:firstValue(raw,["site","source_site"]),phone:firstValue(raw,["phone","phone_number","phone_numbers"]),socialPlatforms:firstValue(raw,["social_platforms"]),extra});
  }
  return {contacts,stats:{total:mapped.length,missingEmail,duplicates}};
}

async function importCsv(file) {
  try { const result=parseCsv(await file.text()); if(!result.contacts.length)throw new Error("No valid email addresses were found in this file."); state.contacts=result.contacts; state.queue=result.contacts.map(c=>({contactId:c.id,status:"new"})); await persist(); render(); const s=result.stats; $("importSummary").innerHTML=`<b>${result.contacts.length} ready</b> · ${s.missingEmail} without email skipped${s.duplicates?` · ${s.duplicates} duplicate${s.duplicates===1?"":"s"} skipped`:""}`; status(`Imported ${result.contacts.length} unique customer profiles.`); }
  catch(error){ status(error.message,true); }
}

async function generateOne(item) {
  const contact=state.contacts.find(c=>c.id===item.contactId); if(!contact) return;
  item.status="generating"; render();
  const response=await chrome.runtime.sendMessage({type:"GENERATE_EMAIL",payload:{contact,settings:state.settings}});
  if(!response.ok){item.status="error";item.error=response.error;throw new Error(response.error);}
  Object.assign(item,response.draft,{status:"ready"}); await persist(); render();
}

async function generateAll() {
  await saveSettings();
  const pending=state.queue.filter(i=>i.status==="new"||i.status==="error");
  for(let i=0;i<pending.length;i++){status(`Generating ${i+1} of ${pending.length}…`);try{await generateOne(pending[i]);}catch(e){status(e.message,true);return;}}
  status(`Generated ${pending.length} draft${pending.length===1?"":"s"}. Review before sending.`);
}

async function privateEmailTab() {
  const tabs=await chrome.tabs.query({url:"https://privateemail.com/*"});
  if(!tabs.length) throw new Error("Open Private Email in a browser tab first.");
  return tabs.find(t=>t.active)||tabs[0];
}

async function sendItem(item, forceSend=false) {
  const contact=state.contacts.find(c=>c.id===item.contactId); if(!contact||!item.subject||!item.body?.trim()) throw new Error("Generate a complete draft with a non-empty body first.");
  await logEvent("info", "prepare_requested", { contactId: item.contactId, email: contact.email, subjectLength: item.subject.length, bodyLength: item.body.length, autoSend: forceSend });
  let response;
  try { const tab=await privateEmailTab(); response=await chrome.tabs.sendMessage(tab.id,{type:"PRIVATE_EMAIL_COMPOSE",payload:{to:contact.email,subject:item.subject,body:item.body,send:forceSend}}); }
  catch(error){await logEvent("error","prepare_failed",{contactId:item.contactId,email:contact.email,error:error.message});throw error;}
  if(!response?.ok){await logEvent("error","prepare_failed",{contactId:item.contactId,email:contact.email,error:response?.error||"No response"});throw new Error(response?.error||"Private Email did not accept the draft.");}
  item.status=forceSend?"sent":"prepared"; await persist(); render();
  await logEvent("info", forceSend ? "send_completed" : "prepare_completed", { contactId: item.contactId, email: contact.email });
}

async function refreshLogs(){const {diagnosticLogs=[]}=await chrome.storage.local.get("diagnosticLogs");$("logCount").textContent=`${diagnosticLogs.length} entr${diagnosticLogs.length===1?"y":"ies"}`;$("logViewer").value=diagnosticLogs.map(entry=>JSON.stringify(entry)).join("\n");return diagnosticLogs;}

async function runQueue() {
  if(running)return; running=true;
  try{
    await saveSettings(); const ready=state.queue.filter(i=>i.status==="ready");
    if(!ready.length) throw new Error("There are no reviewed drafts ready.");
    if(!state.settings.autoSend){await sendItem(ready[0],false);status("Draft prepared in Private Email. Review it there, then send.");return;}
    if(!confirm(`Send ${ready.length} prepared emails automatically? Confirm consent and legal compliance before continuing.`))return;
    for(let i=0;i<ready.length&&running;i++){status(`Sending ${i+1} of ${ready.length}…`);await sendItem(ready[i],true);if(i<ready.length-1){const min=state.settings.minPause,max=state.settings.maxPause;await new Promise(r=>setTimeout(r,(min+Math.random()*(max-min))*1000));}}
    status("Queue complete.");
  }catch(e){status(e.message,true);}finally{running=false;}
}

async function testConnection(){try{const tab=await privateEmailTab();const r=await chrome.tabs.sendMessage(tab.id,{type:"PRIVATE_EMAIL_PING"});$("connection").textContent=r?.ok?"Connected":"Not connected";$("connection").classList.toggle("good",Boolean(r?.ok));}catch{$("connection").textContent="Open Private Email";}}
async function persist(){await chrome.storage.local.set({contacts:state.contacts,queue:state.queue});}
function render(){
  $("contactCount").textContent=state.contacts.length;$("draftCount").textContent=state.queue.filter(i=>["ready","prepared","sent"].includes(i.status)).length;$("sentCount").textContent=state.queue.filter(i=>i.status==="sent").length;
  $("contactsList").className=`list${state.contacts.length?"":" empty"}`;$("contactsList").innerHTML=state.contacts.length?state.contacts.map(c=>`<div class="contact"><b>${esc(c.name||c.email)}</b><small>${esc(c.email)}${c.company?` · ${esc(c.company)}`:""}</small></div>`).join(""):"No contacts imported.";
  $("queue").className=`queue${state.queue.length?"":" empty"}`;$("queue").innerHTML=state.queue.length?state.queue.map((item,index)=>{const c=state.contacts.find(x=>x.id===item.contactId)||{};return `<div class="queue-item"><div class="queue-head"><b>${esc(c.name||c.email||"Unknown")}</b><span class="badge ${item.status}">${esc(item.status)}</span></div>${item.subject?`<div class="subject">${esc(item.subject)}</div>`:""}${item.error?`<small>${esc(item.error)}</small>`:""}<div class="actions"><button data-action="generate" data-index="${index}">${item.subject?"Regenerate":"Generate"}</button>${item.subject?`<button data-action="prepare" data-index="${index}">Prepare in mail</button>`:""}</div></div>`}).join(""):"Import contacts to begin.";
  document.querySelectorAll("[data-action]").forEach(b=>b.onclick=async()=>{try{await saveSettings();const item=state.queue[Number(b.dataset.index)];b.dataset.action==="generate"?await generateOne(item):await sendItem(item,false);status(b.dataset.action==="generate"?"Draft generated.":"Draft prepared in Private Email.");}catch(e){status(e.message,true);}});
}
function esc(value){const d=document.createElement("div");d.textContent=value??"";return d.innerHTML;}

$("csvFile").addEventListener("change",e=>e.target.files[0]&&importCsv(e.target.files[0]));
$("saveSettings").onclick=saveSettings;$("saveCampaign").onclick=saveSettings;$("generateAll").onclick=generateAll;$("runQueue").onclick=runQueue;
$("autoSend").onchange=saveSettings;
$("viewLogs").onclick=async()=>{await refreshLogs();$("logViewer").hidden=!$("logViewer").hidden;$("viewLogs").textContent=$("logViewer").hidden?"View":"Hide";};
$("exportLogs").onclick=async()=>{const logs=await refreshLogs();const blob=new Blob([logs.map(entry=>JSON.stringify(entry)).join("\n")+"\n"],{type:"application/x-ndjson"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`sin-email-debug-${new Date().toISOString().replace(/[:.]/g,"-")}.ndjson`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);status(`Exported ${logs.length} diagnostic log entries.`);};
$("clearLogs").onclick=async()=>{if(confirm("Clear all diagnostic log entries?")){await chrome.storage.local.remove("diagnosticLogs");await refreshLogs();status("Diagnostic log cleared.");}};
$("clearContacts").onclick=async()=>{if(confirm("Remove all imported contacts and drafts?")){state.contacts=[];state.queue=[];await persist();render();}};
$("downloadSample").onclick=()=>{const csv='email,name,company,role,persona,interests,problem,notes,profile_url,site\nalex@example.com,Alex Morgan,Example Co,Operations Director,Efficiency focused,"automation, analytics",Manual reporting,Met at conference,https://example.com/alex,example.com';const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download="sin-customer-profile-template.csv";a.click();URL.revokeObjectURL(a.href);};
init();
