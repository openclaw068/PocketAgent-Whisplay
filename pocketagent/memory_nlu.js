import { chat } from './openai.js';

export async function classifyMemoryUtterance({ baseUrl, apiKeyEnv, model, text }) {
  const schema = {
    intent: ['remember_fact', 'query_memory', 'forget_memory', 'unknown'],
    // remember_fact
    factText: 'string|null',
    // query
    queryText: 'string|null',
    // forget
    forgetQuery: 'string|null'
  };

  const sys =
    'You are PocketAgent. Classify a user utterance related to long-term semantic memory. ' +
    'Return ONLY valid JSON. ' +
    'Use intent="remember_fact" when the user says "remember that ..." or "remember: ..." or "remember I ...". ' +
    'Use intent="query_memory" when the user asks "where is/are ...", "what did I do with ...", "do you remember ...", or similar. ' +
    'Use intent="forget_memory" when the user says to forget/delete a memory. ' +
    'Do NOT include reminders scheduling unless it is clearly about remembering a fact/location rather than a timed reminder.';

  const content = await chat({
    baseUrl,
    apiKeyEnv,
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify({ text, schema }) }
    ]
  });

  try {
    return JSON.parse(content);
  } catch {
    return { intent: 'unknown', factText: null, queryText: null, forgetQuery: null };
  }
}
