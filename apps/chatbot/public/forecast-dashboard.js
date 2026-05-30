const state = {
  token: localStorage.getItem("srLocalAiToken") || "",
  weekly: null,
  tax: null
};

const $ = (id) => document.getElementById(id);
const money = (value) => `₹${Number(value || 0).toFixed(2)}`;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || data?.detail || `Request failed ${response.status}`);
  return data;
}

function confidenceText(row, formatter = money) {
  return `${formatter(row.lower)} – ${formatter(row.upper)} confidence range`;
}

function trendText(trend) {
  if (!trend) return "—";
  if (trend.direction === "up") return `Trend up ${trend.percent}%`;
  if (trend.direction === "down") return `Trend down ${Math.abs(trend.percent)}%`;
  return "Trend stable";
}

function drawForecast(canvas, forecast, color) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--card");
  ctx.fillRect(0, 0, width, height);

  const rows = forecast?.predictions || [];
  if (!rows.length) return;
  const values = rows.flatMap((row) => [Number(row.lower), Number(row.upper), Number(row.value)]);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const pad = 38;
  const x = (index) => pad + (index * (width - pad * 2)) / Math.max(1, rows.length - 1);
  const y = (value) => height - pad - ((value - min) * (height - pad * 2)) / Math.max(1, max - min);

  ctx.strokeStyle = "rgba(100,116,139,.25)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const yy = pad + (i * (height - pad * 2)) / 3;
    ctx.beginPath();
    ctx.moveTo(pad, yy);
    ctx.lineTo(width - pad, yy);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(15,118,110,.12)";
  ctx.beginPath();
  rows.forEach((row, index) => {
    const xx = x(index);
    const yy = y(Number(row.upper));
    if (index === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  [...rows].reverse().forEach((row, reverseIndex) => {
    const index = rows.length - 1 - reverseIndex;
    ctx.lineTo(x(index), y(Number(row.lower)));
  });
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  rows.forEach((row, index) => {
    const xx = x(index);
    const yy = y(Number(row.value));
    if (index === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.stroke();

  ctx.fillStyle = color;
  rows.forEach((row, index) => {
    ctx.beginPath();
    ctx.arc(x(index), y(Number(row.value)), 4, 0, Math.PI * 2);
    ctx.fill();
  });
}

async function login() {
  const username = $("username").value.trim();
  const password = $("password").value;
  const data = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
  state.token = data.token;
  localStorage.setItem("srLocalAiToken", state.token);
  $("loginCard").classList.add("hidden");
  await loadForecasts();
}

async function loadForecasts() {
  const shopId = $("shopId").value;
  const qs = shopId ? `?shopId=${encodeURIComponent(shopId)}` : "";
  const [tomorrow, weekly, monthly, tax] = await Promise.all([
    api(`/api/predictions/tomorrow-sales${qs}`),
    api(`/api/predictions/weekly-revenue${qs}`),
    api(`/api/predictions/monthly-revenue${qs}`),
    api(`/api/predictions/tax-forecast${qs}`)
  ]);

  state.weekly = weekly;
  state.tax = tax;
  const tomorrowRevenue = tomorrow.revenue.predictions[0];
  const tomorrowInvoices = tomorrow.invoiceCount.predictions[0];
  $("tomorrowRevenue").textContent = money(tomorrowRevenue.value);
  $("tomorrowRevenueCi").textContent = confidenceText(tomorrowRevenue);
  $("tomorrowInvoices").textContent = String(tomorrowInvoices.value);
  $("tomorrowInvoicesCi").textContent = confidenceText(tomorrowInvoices, (v) => String(v));
  $("weeklyRevenue").textContent = money(weekly.total.value);
  $("weeklyModel").textContent = weekly.selectedModel;
  $("taxForecast").textContent = money(tax.total.value);
  $("taxModel").textContent = tax.selectedModel;
  $("weeklyTrend").textContent = trendText(weekly.trend);
  $("taxTrend").textContent = trendText(tax.trend);
  $("generatedAt").textContent = `Generated ${weekly.generatedAt}`;

  drawForecast($("weeklyChart"), weekly, "#0f766e");
  drawForecast($("taxChart"), tax, "#2563eb");
  $("insights").innerHTML = [...weekly.insights, ...monthly.insights, ...tax.insights]
    .map((item) => `<li>${item}</li>`)
    .join("");
}

$("login").addEventListener("click", () => login().catch((error) => alert(error.message)));
$("refresh").addEventListener("click", () => loadForecasts().catch((error) => alert(error.message)));
$("darkMode").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  if (state.weekly) drawForecast($("weeklyChart"), state.weekly, "#0f766e");
  if (state.tax) drawForecast($("taxChart"), state.tax, "#2563eb");
});

if (state.token) {
  $("loginCard").classList.add("hidden");
  loadForecasts().catch(() => {
    localStorage.removeItem("srLocalAiToken");
    state.token = "";
    $("loginCard").classList.remove("hidden");
  });
}
