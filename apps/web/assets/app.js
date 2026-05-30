export async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(opts.headers || {})
    }
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = data?.error?.message || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

export function money(n) {
  const v = Number(n || 0);
  return `₹${v.toFixed(2)}`;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

let toastTimer = null;

export function toast(title, message, opts = {}) {
  const el = $("#toast");
  if (!el) return alert(`${title}\n\n${message}`);
  $(".t", el).textContent = title;
  $(".m", el).textContent = message;

  let actions = $(".toast-actions", el);
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "toast-actions";
    el.appendChild(actions);
  }

  actions.innerHTML = "";
  const actionLabel = String(opts?.actionLabel ?? "").trim();
  const onAction = opts?.onAction;
  if (actionLabel && typeof onAction === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => {
      try {
        const res = onAction();
        if (res && typeof res.then === "function") res.catch(() => {});
      } catch {}
      el.classList.remove("show");
    });
    actions.appendChild(btn);
    actions.style.display = "";
  } else {
    actions.style.display = "none";
  }

  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  const durationMs = Number(opts?.durationMs ?? (actionLabel ? 10000 : 3500));
  toastTimer = setTimeout(() => el.classList.remove("show"), durationMs);
}

export async function requireAuth() {
  try {
    const me = await api("/api/auth/me");
    return me.user;
  } catch {
    window.location.href = "/login.html";
    return null;
  }
}

export function todayIso() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const SETTINGS_KEY = "sr_saas_settings_v1";

const DEFAULT_SETTINGS = {
  companyName: "SR Groups",
  logoDataUrl: "",
  address: "Challakere, Karnataka",
  currency: "INR",
  timezone: "Asia/Kolkata",
  language: "English",
  themeMode: "light",
  accent: "#0f766e",
  accent2: "#2563eb",
  font: "Inter",
  density: "comfortable",
  aiEnabled: true,
  localModel: "llama3",
  aiResponseLength: "balanced",
  forecastHorizon: "30",
  confidence: "90",
  invoicePrefix: "SR",
  invoicePadding: "6",
  gstRate: "18",
  paymentTerms: "Due on receipt",
  defaultNotes: "Thank you for your business.",
  emailNotifications: false,
  smsNotifications: true,
  systemAlerts: true,
  apiBaseUrl: "",
  performanceMode: "balanced"
};

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  applySettings(settings);
}

function isAppPage() {
  const path = window.location.pathname;
  return ["/dashboard.html", "/shop.html", "/owner.html"].includes(path);
}

function getPageTitle() {
  const title = document.querySelector(".brand-title")?.textContent?.trim();
  if (title) return title;
  return document.title.replace("• SR Groups", "").trim() || "Workspace";
}

function hexToRgb(hex) {
  const normalized = String(hex || "#0f766e").replace("#", "");
  const full = normalized.length === 3 ? normalized.split("").map((x) => x + x).join("") : normalized;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n)) return "15,118,110";
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function applySettings(settings = readSettings()) {
  const root = document.documentElement;
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--accent2", settings.accent2);
  root.style.setProperty("--accent-rgb", hexToRgb(settings.accent));
  root.style.setProperty("--app-font", settings.font === "System" ? "system-ui" : settings.font);
  document.body.classList.toggle("theme-dark", settings.themeMode === "dark");
  document.body.classList.toggle("theme-auto", settings.themeMode === "auto");
  document.body.classList.toggle("density-compact", settings.density === "compact");
  document.body.classList.toggle("ai-disabled", !settings.aiEnabled);
  const companyNodes = document.querySelectorAll("[data-company-name]");
  companyNodes.forEach((node) => (node.textContent = settings.companyName));
}

function settingsField(label, input) {
  return `<label class="settings-field"><span>${label}</span>${input}</label>`;
}

function buildSettingsModal(settings) {
  return `
    <div id="settingsModal" class="settings-modal" aria-hidden="true">
      <div class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div class="settings-head">
          <div>
            <div class="eyebrow">Control Center</div>
            <h2 id="settingsTitle">Settings</h2>
            <p>Configure company, theme, invoices, local AI, users, notifications, backup, and advanced options.</p>
          </div>
          <button class="icon-btn" data-close-settings aria-label="Close settings">×</button>
        </div>
        <div class="settings-body">
          <aside class="settings-tabs">
            ${["General","Theme","AI","Invoice","Users","Notifications","Backup","Advanced"].map((name, idx) => `
              <button class="${idx === 0 ? "active" : ""}" data-settings-tab="${name.toLowerCase()}">${name}</button>
            `).join("")}
          </aside>
          <form id="settingsForm" class="settings-content">
            <section data-settings-pane="general" class="settings-pane active">
              <h3>General Settings</h3>
              <div class="settings-grid">
                ${settingsField("Company name", `<input name="companyName" value="${escapeHtml(settings.companyName)}" />`)}
                ${settingsField("Logo", `<input name="logoFile" type="file" accept="image/*" />`)}
                ${settingsField("Address", `<textarea name="address" rows="3">${escapeHtml(settings.address)}</textarea>`)}
                ${settingsField("Currency", `<select name="currency"><option value="INR">₹ INR</option><option value="USD">$ USD</option><option value="EUR">€ EUR</option></select>`)}
                ${settingsField("Timezone", `<select name="timezone"><option>Asia/Kolkata</option><option>UTC</option><option>Asia/Dubai</option></select>`)}
                ${settingsField("Language", `<select name="language"><option>English</option><option>Kannada</option><option>Hindi</option></select>`)}
              </div>
            </section>
            <section data-settings-pane="theme" class="settings-pane">
              <h3>Theme Settings</h3>
              <div class="settings-grid">
                ${settingsField("Theme mode", `<select name="themeMode"><option value="light">Light mode</option><option value="dark">Dark mode</option><option value="auto">Auto mode</option></select>`)}
                ${settingsField("Accent color", `<input name="accent" type="color" value="${settings.accent}" />`)}
                ${settingsField("Secondary accent", `<input name="accent2" type="color" value="${settings.accent2}" />`)}
                ${settingsField("Font", `<select name="font"><option>Inter</option><option>Aptos</option><option>System</option><option>Manrope</option></select>`)}
                ${settingsField("Density", `<select name="density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select>`)}
              </div>
            </section>
            <section data-settings-pane="ai" class="settings-pane">
              <h3>AI Settings</h3>
              <div class="settings-grid">
                ${settingsField("AI assistant", `<select name="aiEnabled"><option value="true">Enabled</option><option value="false">Disabled</option></select>`)}
                ${settingsField("Local model", `<select name="localModel"><option value="llama3">Llama 3</option><option value="qwen">Qwen</option><option value="mistral">Mistral</option><option value="gemma">Gemma</option></select>`)}
                ${settingsField("Response length", `<select name="aiResponseLength"><option value="short">Short</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select>`)}
                ${settingsField("Forecast horizon", `<select name="forecastHorizon"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select>`)}
                ${settingsField("Prediction confidence", `<input name="confidence" type="range" min="70" max="99" value="${settings.confidence}" />`)}
              </div>
            </section>
            <section data-settings-pane="invoice" class="settings-pane">
              <h3>Invoice Settings</h3>
              <div class="settings-grid">
                ${settingsField("Invoice prefix", `<input name="invoicePrefix" value="${escapeHtml(settings.invoicePrefix)}" />`)}
                ${settingsField("Number padding", `<input name="invoicePadding" type="number" min="3" max="10" value="${settings.invoicePadding}" />`)}
                ${settingsField("GST / Tax rate", `<input name="gstRate" type="number" min="0" max="40" step="0.01" value="${settings.gstRate}" />`)}
                ${settingsField("Payment terms", `<input name="paymentTerms" value="${escapeHtml(settings.paymentTerms)}" />`)}
                ${settingsField("Default notes", `<textarea name="defaultNotes" rows="3">${escapeHtml(settings.defaultNotes)}</textarea>`)}
              </div>
            </section>
            <section data-settings-pane="users" class="settings-pane">
              <h3>User Management</h3>
              <div class="settings-card-list">
                <div><b>Owner</b><span>Full dashboard, reports, settings, users, and access control.</span></div>
                <div><b>Staff</b><span>Billing, stock, expenses, reports, and shop-specific data.</span></div>
                <div><b>Permissions</b><span>Role permissions are enforced by authenticated API access and shop isolation.</span></div>
              </div>
            </section>
            <section data-settings-pane="notifications" class="settings-pane">
              <h3>Notification Settings</h3>
              <div class="settings-grid">
                ${settingsField("Email notifications", `<select name="emailNotifications"><option value="false">Disabled</option><option value="true">Enabled</option></select>`)}
                ${settingsField("SMS notifications", `<select name="smsNotifications"><option value="true">Enabled</option><option value="false">Disabled</option></select>`)}
                ${settingsField("System alerts", `<select name="systemAlerts"><option value="true">Enabled</option><option value="false">Disabled</option></select>`)}
              </div>
            </section>
            <section data-settings-pane="backup" class="settings-pane">
              <h3>Backup & Restore</h3>
              <div class="settings-actions">
                <button class="btn" type="button" id="exportSettings">Export settings</button>
                <label class="btn" for="importSettingsFile">Import settings</label>
                <input id="importSettingsFile" type="file" accept="application/json" hidden />
                <button class="btn" type="button" data-backup-db>Database backup</button>
              </div>
            </section>
            <section data-settings-pane="advanced" class="settings-pane">
              <h3>Advanced Settings</h3>
              <div class="settings-grid">
                ${settingsField("API configuration", `<input name="apiBaseUrl" placeholder="Default: same origin" value="${escapeHtml(settings.apiBaseUrl)}" />`)}
                ${settingsField("Performance", `<select name="performanceMode"><option value="balanced">Balanced</option><option value="speed">Speed</option><option value="quality">Quality</option></select>`)}
              </div>
              <div class="settings-card-list">
                <div><b>System maintenance</b><span>Use backup before major imports, report generation, or database migration.</span></div>
              </div>
            </section>
          </form>
        </div>
        <div class="settings-foot">
          <button class="btn" type="button" data-close-settings>Cancel</button>
          <button class="btn primary" type="submit" form="settingsForm">Save Settings</button>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>\"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function openSettings() {
  document.getElementById("settingsModal")?.classList.add("show");
}

function closeSettings() {
  document.getElementById("settingsModal")?.classList.remove("show");
}

function collectSettings(form, current) {
  const data = new FormData(form);
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (data.has(key)) {
      const value = data.get(key);
      if (value === "true") next[key] = true;
      else if (value === "false") next[key] = false;
      else next[key] = String(value ?? "");
    }
  }
  return next;
}

function syncSettingsForm(form, settings) {
  for (const [key, value] of Object.entries(settings)) {
    const el = form.elements[key];
    if (!el) continue;
    el.value = String(value);
  }
}

function exportSettings(settings) {
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sr-groups-settings.json";
  a.click();
  URL.revokeObjectURL(url);
}

function buildSidebar() {
  const qs = new URLSearchParams(location.search);
  const shopId = qs.get("shopId") || "1";
  const shopHref = (hash = "") => `/shop.html?shopId=${encodeURIComponent(shopId)}${hash}`;
  const links = [
    ["Dashboard", "/dashboard.html", "⌘"],
    ["Billing", shopHref("#billing"), "₹"],
    ["Stock", shopHref("#stock"), "□"],
    ["Invoice", shopHref("#boi"), "↗"],
    ["Sales", shopHref("#sales"), "◌"],
    ["Reports", shopHref("#reports"), "◆"],
    ["Owner", "/owner.html", "◎"]
  ];
  return `
    <aside class="app-sidebar" aria-label="Primary navigation">
      <div class="side-brand">
        <div class="brand-badge"></div>
        <div><b data-company-name>${escapeHtml(readSettings().companyName)}</b><span>Finance OS</span></div>
      </div>
      <nav>
        ${links.map(([label, href, icon]) => `<a href="${href}" class="${location.pathname === href.split("#")[0] ? "active" : ""}"><span>${icon}</span>${label}</a>`).join("")}
      </nav>
      <div class="side-status">
        <span class="status-dot"></span>
        <div><b>Local-first</b><small>Secure enterprise mode</small></div>
      </div>
    </aside>
  `;
}

function buildCommandPalette() {
  const shopId = new URLSearchParams(location.search).get("shopId") || "1";
  const shopHref = (hash = "") => `/shop.html?shopId=${encodeURIComponent(shopId)}${hash}`;
  const actions = [
    ["Create Bill", shopHref("#billing"), "Open billing counter"],
    ["Manage Stock", shopHref("#stock"), "Products and quantities"],
    ["Bill of Invoice", shopHref("#boi"), "Incoming stock"],
    ["Reports", shopHref("#reports"), "Daily PDF reports"],
    ["Dashboard", "/dashboard.html", "Executive overview"],
    ["Owner View", "/owner.html", "All business units"],
    ["Settings", "#settings", "Open control center"]
  ];
  return `
    <div id="commandPalette" class="command-overlay" aria-hidden="true">
      <div class="command-panel" role="dialog" aria-modal="true">
        <div class="command-input-wrap">
          <span>⌕</span>
          <input id="commandInput" placeholder="Search commands, pages, reports..." autocomplete="off" />
          <kbd>Esc</kbd>
        </div>
        <div id="commandResults" class="command-results">
          ${actions.map(([label, href, desc], idx) => `
            <button data-command-index="${idx}" data-href="${href}">
              <b>${label}</b><span>${desc}</span>
            </button>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function buildNotificationCenter() {
  return `
    <div id="notificationPanel" class="notification-panel">
      <div class="panel-head"><b>Notifications</b><span>Live center</span></div>
      <div class="notify-item success"><b>System ready</b><span>Billing, stock, reports, and local forecasting are configured.</span></div>
      <div class="notify-item"><b>Backup reminder</b><span>Export settings before major stock imports.</span></div>
      <div class="notify-item warn"><b>Low stock watch</b><span>Check products under minimum quantity regularly.</span></div>
    </div>
  `;
}

function buildProfilePanel() {
  const settings = readSettings();
  return `
    <div id="profilePanel" class="profile-panel">
      <div class="profile-card-head">
        <div class="profile-avatar">${escapeHtml(settings.companyName.slice(0, 1).toUpperCase())}</div>
        <div><b>${escapeHtml(settings.companyName)}</b><span>Enterprise workspace</span></div>
      </div>
      <button type="button" data-profile-settings>Settings</button>
      <button type="button" data-profile-command>Command palette</button>
      <button type="button" data-profile-access>Roles & permissions</button>
      <button type="button" data-profile-logout class="danger">Logout</button>
    </div>
  `;
}

function initSettingsModal(settings) {
  document.body.insertAdjacentHTML("beforeend", buildSettingsModal(settings));
  const modal = document.getElementById("settingsModal");
  const form = document.getElementById("settingsForm");
  syncSettingsForm(form, settings);

  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest("[data-close-settings]")) closeSettings();
  });

  modal.querySelectorAll("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      modal.querySelectorAll("[data-settings-tab]").forEach((x) => x.classList.remove("active"));
      modal.querySelectorAll("[data-settings-pane]").forEach((x) => x.classList.remove("active"));
      button.classList.add("active");
      modal.querySelector(`[data-settings-pane="${button.dataset.settingsTab}"]`)?.classList.add("active");
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = readSettings();
    const next = collectSettings(form, current);
    const logo = form.elements.logoFile?.files?.[0];
    if (logo) {
      next.logoDataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(logo);
      });
    }
    saveSettings(next);
    toast("Settings saved", "Your workspace settings were applied.");
    closeSettings();
  });

  document.getElementById("exportSettings")?.addEventListener("click", () => exportSettings(readSettings()));
  document.getElementById("importSettingsFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      saveSettings({ ...DEFAULT_SETTINGS, ...imported });
      syncSettingsForm(form, readSettings());
      toast("Settings imported", "Imported settings are now active.");
    } catch {
      toast("Import failed", "Please choose a valid settings JSON file.");
    }
  });
  modal.querySelector("[data-backup-db]")?.addEventListener("click", () => {
    toast("Backup", "Use the server database file or Docker volume backup for full data backup.");
  });
}

function initCommandPalette() {
  document.body.insertAdjacentHTML("beforeend", buildCommandPalette());
  const overlay = document.getElementById("commandPalette");
  const input = document.getElementById("commandInput");
  const results = document.getElementById("commandResults");
  const open = () => {
    overlay.classList.add("show");
    input.value = "";
    [...results.children].forEach((node) => (node.style.display = ""));
    setTimeout(() => input.focus(), 30);
  };
  const close = () => overlay.classList.remove("show");

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
    }
    if (event.key === "Escape") {
      close();
      closeSettings();
      document.getElementById("notificationPanel")?.classList.remove("show");
      document.getElementById("profilePanel")?.classList.remove("show");
    }
  });
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
    const btn = event.target.closest("button[data-href]");
    if (!btn) return;
    const href = btn.dataset.href;
    if (href === "#settings") openSettings();
    else window.location.href = href;
    close();
  });
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    [...results.children].forEach((node) => {
      node.style.display = node.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  });
  window.openCommandPalette = open;
}


function buildAiChatWidget() {
  const settings = readSettings();
  const disabled = !settings.aiEnabled;
  return `
    <section id="aiChatWidget" class="ai-chat-widget ${disabled ? "disabled" : ""}" aria-live="polite">
      <button id="aiChatLauncher" class="ai-chat-launcher" type="button" aria-label="Open local AI assistant">
        <span class="ai-orb"></span><span>AI</span>
      </button>
      <div id="aiChatPanel" class="ai-chat-panel" aria-hidden="true">
        <div class="ai-chat-head">
          <div>
            <div class="eyebrow">Local Ollama Assistant</div>
            <h3>Business AI</h3>
            <p>No cloud AI. Runs on your server.</p>
          </div>
          <div class="row" style="gap:6px">
            <select id="aiModelSelect" title="Local model">
              <option value="llama3">Llama 3</option>
              <option value="qwen">Qwen</option>
              <option value="mistral">Mistral</option>
              <option value="gemma">Gemma</option>
            </select>
            <button id="aiChatMinimize" class="icon-btn" type="button" aria-label="Minimize AI chat">−</button>
          </div>
        </div>
        <div id="aiChatMessages" class="ai-chat-messages">
          <div class="ai-msg assistant"><div class="ai-msg-bubble">Ask about invoices, payments, products, reports, sales trends, or forecasts. Start the local AI backend on port 4000 to enable live answers.</div></div>
        </div>
        <div class="ai-suggestions">
          <button type="button">Tomorrow revenue forecast</button>
          <button type="button">Today payment summary</button>
          <button type="button">Low stock products</button>
        </div>
        <form id="aiChatForm" class="ai-chat-form">
          <textarea id="aiChatInput" rows="2" placeholder="Ask local AI..." ${disabled ? "disabled" : ""}></textarea>
          <button class="btn primary" type="submit" ${disabled ? "disabled" : ""}>Send</button>
        </form>
        <div id="aiChatStatus" class="ai-chat-status">${disabled ? "AI disabled in Settings" : "Self-hosted mode • Ollama local models only"}</div>
      </div>
    </section>
  `;
}

function markdownToHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br />");
}

function appendAiMessage(role, content) {
  const host = document.getElementById("aiChatMessages");
  if (!host) return null;
  const row = document.createElement("div");
  row.className = `ai-msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "ai-msg-bubble";
  bubble.innerHTML = markdownToHtml(content);
  row.appendChild(bubble);
  host.appendChild(row);
  host.scrollTop = host.scrollHeight;
  return bubble;
}

async function getLocalAiToken() {
  return sessionStorage.getItem("sr_local_ai_token") || localStorage.getItem("srLocalAiToken") || "";
}

async function streamLocalAi(message, model, onToken, onMeta) {
  const token = await getLocalAiToken();
  if (!token) throw new Error("Local AI login required. Open http://localhost:4000/forecast-dashboard.html once and login, or connect JWT auth.");
  const res = await fetch("http://localhost:4000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, model })
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message || `Local AI backend unavailable (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((x) => x.startsWith("data:"));
      if (!line) continue;
      const payload = JSON.parse(line.slice(5).trim());
      if (payload.type === "meta") onMeta?.(payload);
      if (payload.type === "token") onToken(payload.token || "");
      if (payload.type === "error") throw new Error(payload.message || "AI error");
    }
  }
}

function initAiChatWidget() {
  document.body.insertAdjacentHTML("beforeend", buildAiChatWidget());
  const panel = document.getElementById("aiChatPanel");
  const launcher = document.getElementById("aiChatLauncher");
  const minimize = document.getElementById("aiChatMinimize");
  const form = document.getElementById("aiChatForm");
  const input = document.getElementById("aiChatInput");
  const modelSelect = document.getElementById("aiModelSelect");
  const status = document.getElementById("aiChatStatus");
  const settings = readSettings();
  modelSelect.value = settings.localModel || "llama3";
  const open = () => { panel.classList.add("show"); panel.setAttribute("aria-hidden", "false"); setTimeout(() => input?.focus(), 40); };
  const close = () => { panel.classList.remove("show"); panel.setAttribute("aria-hidden", "true"); };
  launcher?.addEventListener("click", () => panel.classList.contains("show") ? close() : open());
  minimize?.addEventListener("click", close);
  document.querySelectorAll(".ai-suggestions button").forEach((button) => {
    button.addEventListener("click", () => { input.value = button.textContent.trim(); open(); input.focus(); });
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    appendAiMessage("user", message);
    const bubble = appendAiMessage("assistant typing", "Thinking locally...");
    let output = "";
    try {
      status.textContent = "Connecting to local Ollama backend...";
      await streamLocalAi(message, modelSelect.value, (token) => {
        output += token;
        bubble.innerHTML = markdownToHtml(output || "...");
        document.getElementById("aiChatMessages").scrollTop = document.getElementById("aiChatMessages").scrollHeight;
      }, () => { status.textContent = `Streaming from ${modelSelect.value}`; });
      status.textContent = "Done • fully local";
    } catch (error) {
      bubble.innerHTML = markdownToHtml(`Local AI is not connected yet.\n\n${error.message}\n\nStart it with: \`cd apps/chatbot && npm start\` and Ollama with: \`ollama serve\`.`);
      status.textContent = "Local AI backend unavailable";
    }
  });
  window.openLocalAiChat = open;
}

function initSaasShell() {
  const settings = readSettings();
  applySettings(settings);
  initSettingsModal(settings);

  if (!isAppPage()) return;
  document.body.classList.add("has-saas-shell");
  document.body.insertAdjacentHTML("afterbegin", buildSidebar());
  document.body.insertAdjacentHTML("beforeend", buildNotificationCenter());
  document.body.insertAdjacentHTML("beforeend", buildProfilePanel());
  initCommandPalette();
  initAiChatWidget();

  const navRow = document.querySelector(".nav .row");
  if (navRow) {
    navRow.insertAdjacentHTML("afterbegin", `
      <button class="btn small shell-command" type="button" title="Command palette">⌘K</button>
      <button class="btn small shell-notify" type="button" title="Notifications">●</button>
      <button class="btn small shell-settings" type="button">Settings</button>
      <button class="btn small shell-profile" type="button">${escapeHtml(getPageTitle()).slice(0, 1)}</button>
    `);
  }
  document.querySelector(".shell-settings")?.addEventListener("click", openSettings);
  document.querySelector(".shell-command")?.addEventListener("click", () => window.openCommandPalette?.());
  document.querySelector(".shell-notify")?.addEventListener("click", () => {
    document.getElementById("profilePanel")?.classList.remove("show");
    document.getElementById("notificationPanel")?.classList.toggle("show");
  });
  document.querySelector(".shell-profile")?.addEventListener("click", () => {
    document.getElementById("notificationPanel")?.classList.remove("show");
    document.getElementById("profilePanel")?.classList.toggle("show");
  });
  document.querySelector("[data-profile-settings]")?.addEventListener("click", openSettings);
  document.querySelector("[data-profile-command]")?.addEventListener("click", () => window.openCommandPalette?.());
  document.querySelector("[data-profile-access]")?.addEventListener("click", () => {
    openSettings();
    document.querySelector('[data-settings-tab="users"]')?.click();
  });
  document.querySelector("[data-profile-logout]")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => {});
    window.location.href = "/index.html";
  });

  document.body.insertAdjacentHTML("beforeend", `
    <div class="quick-actions">
      <button class="quick-main" aria-label="Quick actions">＋</button>
      <div class="quick-menu">
        <a href="/shop.html?shopId=${encodeURIComponent(new URLSearchParams(location.search).get("shopId") || "1")}#billing">New bill</a>
        <a href="/shop.html?shopId=${encodeURIComponent(new URLSearchParams(location.search).get("shopId") || "1")}#stock">Add stock</a>
        <a href="/shop.html?shopId=${encodeURIComponent(new URLSearchParams(location.search).get("shopId") || "1")}#reports">Report</a>
        <button type="button" data-open-settings>Settings</button>
      </div>
    </div>
  `);
  document.querySelector(".quick-main")?.addEventListener("click", () => document.querySelector(".quick-actions")?.classList.toggle("show"));
  document.querySelector("[data-open-settings]")?.addEventListener("click", openSettings);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSaasShell);
} else {
  initSaasShell();
}
