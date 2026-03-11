import fs from 'node:fs';

function getApiKey(envName = 'OPENAI_API_KEY') {
  const key = process.env[envName];
  if (!key) throw new Error(`Missing ${envName} in environment`);
  return key;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url, init, { timeoutMs = 60_000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      if (res.ok) return res;
      // retry on rate limits and transient errors
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        const backoff = 500 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) throw e;
      const backoff = 500 * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export async function whisperTranscribe({ baseUrl, apiKeyEnv, audioPath, model, prompt = null, language = null, responseFormat = 'json' }) {
  const apiKey = getApiKey(apiKeyEnv);
  const url = `${baseUrl.replace(/\/$/, '')}/audio/transcriptions`;

  const fd = new FormData();
  fd.append('model', model);
  if (prompt) fd.append('prompt', prompt);
  if (language) fd.append('language', language);
  if (responseFormat) fd.append('response_format', responseFormat);

  // Node 18+ provides Blob/FormData. Provide a filename so multipart is well-formed.
  fd.append('file', new Blob([fs.readFileSync(audioPath)]), 'audio.wav');

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`STT transcription failed: ${res.status} ${res.statusText} ${t}`);
  }

  // API may return JSON (default) or plain text (response_format=text)
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const json = await res.json();
    return json.text ?? '';
  }
  return (await res.text().catch(() => '')).trim();
}

export async function chat({ baseUrl, apiKeyEnv, model, messages }) {
  const apiKey = getApiKey(apiKeyEnv);
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Chat failed: ${res.status} ${res.statusText} ${t}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

export async function embed({ baseUrl, apiKeyEnv, model, input }) {
  const apiKey = getApiKey(apiKeyEnv);
  const url = `${baseUrl.replace(/\/$/, '')}/embeddings`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Embeddings failed: ${res.status} ${res.statusText} ${t}`);
  }

  const json = await res.json();
  const vec = json.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('Embeddings response missing embedding vector');
  return vec;
}

export async function ttsToAudio({ baseUrl, apiKeyEnv, model, voice, text, format = 'wav', speed = null }) {
  const apiKey = getApiKey(apiKeyEnv);
  const url = `${baseUrl.replace(/\/$/, '')}/audio/speech`;

  // Some API variants ignore unknown fields. Historically, speech has used either
  // `format` or `response_format` depending on the provider/version.
  // We send both and also set Accept to prefer WAV.
  const body = {
    model,
    voice,
    input: text,
    format,
    response_format: format,
    ...(speed != null ? { speed: Number(speed) } : {})
  };

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: format === 'wav' ? 'audio/wav' : 'audio/*'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`TTS failed: ${res.status} ${res.statusText} ${t}`);
  }

  const contentType = res.headers.get('content-type') || '';
  const arrayBuffer = await res.arrayBuffer();
  return { audio: Buffer.from(arrayBuffer), contentType };
}

// Back-compat: older callers expect a Buffer containing WAV bytes.
export async function ttsToWav(opts) {
  const { audio } = await ttsToAudio({ ...opts, format: 'wav' });
  return audio;
}

