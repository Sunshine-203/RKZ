// Server-side AI calls through OpenRouter. The API key lives only in the server environment.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FALLBACK_MODEL = 'google/gemini-3.6-flash';

class AIError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

let fetchImpl = (...args) => fetch(...args); // swappable in tests
function _setFetch(f) { fetchImpl = f; }

function extractJson(text) {
  if (typeof text !== 'string') throw new AIError('AI returned an empty answer. Try again or add steps manually.');
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new AIError('AI answer was not in the expected format. Try again or add steps manually.');
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new AIError('AI answer was not in the expected format. Try again or add steps manually.'); }
}

async function chat(messages, { maxTokens = 1500 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new AIError('AI is not set up on the server yet. You can still add steps manually.');
  const primary = process.env.OPENROUTER_MODEL || 'google/gemini-3.7-flash';
  const models = primary === FALLBACK_MODEL ? [primary] : [primary, FALLBACK_MODEL];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_URL || 'https://rkz.onrender.com',
        'X-Title': 'RKZ Study Planner',
      },
      body: JSON.stringify({
        model: models[0],
        models,
        messages,
        temperature: 0.4,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
  } catch (e) {
    throw new AIError(e.name === 'AbortError'
      ? 'AI took too long to answer. Try again or add steps manually.'
      : 'Could not reach the AI service. Try again or add steps manually.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    console.error('OpenRouter error', res.status, detail);
    if (res.status === 401) throw new AIError('AI key is not valid on the server. You can still add steps manually.');
    if (res.status === 402) throw new AIError('AI credits ran out. You can still add steps manually.');
    if (res.status === 429) throw new AIError('AI is busy right now. Wait a moment and try again.');
    throw new AIError('AI is unavailable right now. Try again or add steps manually.');
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return { json: extractJson(Array.isArray(content) ? content.map((c) => c.text || '').join('') : content), model: data.model || models[0] };
}

// ---------- AI action 1: Suggest Study Steps ----------
function cleanSteps(raw) {
  const list = Array.isArray(raw?.steps) ? raw.steps : [];
  const out = [];
  for (const s of list.slice(0, 10)) {
    if (!s || typeof s.title !== 'string') continue;
    const title = s.title.replace(/\s+/g, ' ').trim().slice(0, 120);
    let minutes = Number(s.minutes);
    if (!title || !Number.isFinite(minutes)) continue;
    minutes = Math.min(480, Math.max(5, Math.round(minutes / 5) * 5));
    out.push({ title, minutes, source: 'ai' });
  }
  if (out.length === 0) throw new AIError('AI could not break this down. Add a little more detail or add steps manually.');
  return out;
}

async function suggestSteps({ title, subject, description, deadline, today, dailyMinutes }) {
  const system = [
    'You are RKZ, a study-planning assistant for university students in Kuwait.',
    'Break the assignment into 3 to 8 concrete, sequential study steps a student can do one at a time.',
    'Each step needs a short action-first title (max 80 characters) and an honest time estimate in minutes (10 to 240).',
    'Estimate realistically for an average university student. Do NOT shrink estimates to fit the available time; the app will warn the student if it does not fit.',
    'Reply with JSON only, exactly in this shape: {"steps":[{"title":"...","minutes":45}]}',
  ].join(' ');
  const user = [
    `Assignment: ${title}`,
    subject ? `Subject: ${subject}` : null,
    description ? `Details from the student: ${description}` : null,
    deadline ? `Deadline: ${deadline} (today is ${today})` : null,
    dailyMinutes ? `The student can study about ${dailyMinutes} minutes per day.` : null,
  ].filter(Boolean).join('\n');

  const { json, model } = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return { steps: cleanSteps(json), model };
}

module.exports = { suggestSteps, chat, extractJson, cleanSteps, AIError, _setFetch };
