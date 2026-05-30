import { config } from "./config.js";

export async function* streamOllamaChat({ model, messages, temperature }) {
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model || config.ollamaModel,
      messages,
      stream: true,
      options: {
        temperature: Number.isFinite(temperature) ? temperature : config.ollamaTemperature
      }
    })
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(`Ollama request failed (${response.status}) ${text}`), {
      status: 503
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const payload = JSON.parse(line);
      if (payload.message?.content) yield payload.message.content;
      if (payload.done) return;
    }
  }
}

export async function listOllamaModels() {
  const response = await fetch(`${config.ollamaBaseUrl}/api/tags`);
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data.models) ? data.models.map((model) => model.name) : [];
}
