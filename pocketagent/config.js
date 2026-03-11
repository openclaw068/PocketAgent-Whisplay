export const DEFAULTS = {
  timezone: 'America/Chicago',
  // Audio
  sampleRateHertz: 16000,
  recordingDevice: process.env.POCKETAGENT_RECORDING_DEVICE || null,
  recordingChannels: Number(process.env.POCKETAGENT_RECORDING_CHANNELS || 1),
  playbackCommand: process.env.POCKETAGENT_PLAYBACK_CMD || 'aplay',
  playbackDevice: process.env.POCKETAGENT_PLAYBACK_DEVICE || null, // e.g. plughw:1,0

  // OpenAI
  openaiApiKeyEnv: 'OPENAI_API_KEY',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  // Keep costs low by default
  whisperModel: process.env.POCKETAGENT_WHISPER_MODEL || 'gpt-4o-mini-transcribe',
  // Keep costs low by default
  chatModel: process.env.POCKETAGENT_CHAT_MODEL || 'gpt-4o-mini',
  ttsModel: process.env.POCKETAGENT_TTS_MODEL || 'gpt-4o-mini-tts',
  ttsVoice: process.env.POCKETAGENT_TTS_VOICE || 'alloy',

  // Embeddings (semantic memory)
  embeddingModel: process.env.POCKETAGENT_EMBEDDING_MODEL || 'text-embedding-3-small',

  // Behavior
  defaultsFile: process.env.POCKETAGENT_DEFAULTS_FILE || './data/defaults.json',
  remindersDbFile: process.env.POCKETAGENT_REMINDERS_DB || './data/reminders.json',

  // Chat mode
  mode: (process.env.POCKETAGENT_MODE || 'reminders').toLowerCase(), // reminders|chat
  chatHistoryFile: process.env.POCKETAGENT_CHAT_HISTORY_FILE || './data/chat_history.json',
  chatCarryoverCount: Number(process.env.POCKETAGENT_CHAT_CARRYOVER_COUNT || 10),

  // Volume (ALSA/amixer)
  alsaCard: process.env.POCKETAGENT_ALSA_CARD ?? null, // e.g. 0, 1
  alsaVolumeControl: process.env.POCKETAGENT_ALSA_VOLUME_CONTROL || 'Speaker',

  // If true, prefer offline TTS when available (Piper). On Pi Zero 2W, this may be too slow/limited.
  preferOfflineTts: (process.env.POCKETAGENT_PREFER_OFFLINE_TTS || '').toLowerCase() === 'true'
};
