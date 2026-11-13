import { safeStorage } from './storageHelpers.ts';

export const VOICE_CHAT_STORAGE_KEY = 'rc_voice_chat_prefs_v1';
export const VOICE_VOLUME_MIN_PCT = 0;
export const VOICE_VOLUME_MAX_PCT = 250;
export const VOICE_VOLUME_DEFAULT_PCT = 100;

export interface VoiceChatPrefsSnapshot {
  micMuted: boolean;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  masterVoiceVolumePct: number;
  outputLimiterEnabled: boolean;
  registeredPlayerVolumes: Record<string, number>;
  registeredPlayerMuted: Record<string, boolean>;
}

export const DEFAULT_VOICE_CHAT_PREFS: VoiceChatPrefsSnapshot = {
  micMuted: false,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  masterVoiceVolumePct: VOICE_VOLUME_DEFAULT_PCT,
  outputLimiterEnabled: true,
  registeredPlayerVolumes: {},
  registeredPlayerMuted: {},
};

export function clampVoiceChatVolumePct(value: unknown, fallback = VOICE_VOLUME_DEFAULT_PCT): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(VOICE_VOLUME_MIN_PCT, Math.min(VOICE_VOLUME_MAX_PCT, Math.round(num)));
}

export function sanitizeVoiceChatPrefs(
  raw: Partial<VoiceChatPrefsSnapshot> | null | undefined
): VoiceChatPrefsSnapshot {
  const src = raw && typeof raw === 'object' ? raw : {};
  const registeredPlayerVolumes: Record<string, number> = {};
  if (src.registeredPlayerVolumes && typeof src.registeredPlayerVolumes === 'object') {
    for (const [playerId, vol] of Object.entries(src.registeredPlayerVolumes)) {
      const cleanId = String(playerId || '').trim();
      if (!cleanId) continue;
      registeredPlayerVolumes[cleanId] = clampVoiceChatVolumePct(vol);
    }
  }
  const registeredPlayerMuted: Record<string, boolean> = {};
  if (src.registeredPlayerMuted && typeof src.registeredPlayerMuted === 'object') {
    for (const [playerId, muted] of Object.entries(src.registeredPlayerMuted)) {
      const cleanId = String(playerId || '').trim();
      if (!cleanId) continue;
      registeredPlayerMuted[cleanId] = Boolean(muted);
    }
  }
  return {
    micMuted: src.micMuted !== undefined ? Boolean(src.micMuted) : DEFAULT_VOICE_CHAT_PREFS.micMuted,
    echoCancellation:
      src.echoCancellation !== undefined
        ? Boolean(src.echoCancellation)
        : DEFAULT_VOICE_CHAT_PREFS.echoCancellation,
    noiseSuppression:
      src.noiseSuppression !== undefined
        ? Boolean(src.noiseSuppression)
        : DEFAULT_VOICE_CHAT_PREFS.noiseSuppression,
    autoGainControl:
      src.autoGainControl !== undefined
        ? Boolean(src.autoGainControl)
        : DEFAULT_VOICE_CHAT_PREFS.autoGainControl,
    masterVoiceVolumePct: clampVoiceChatVolumePct(
      src.masterVoiceVolumePct,
      DEFAULT_VOICE_CHAT_PREFS.masterVoiceVolumePct
    ),
    outputLimiterEnabled:
      src.outputLimiterEnabled !== undefined
        ? Boolean(src.outputLimiterEnabled)
        : DEFAULT_VOICE_CHAT_PREFS.outputLimiterEnabled,
    registeredPlayerVolumes,
    registeredPlayerMuted,
  };
}

export function loadVoiceChatPrefs(): VoiceChatPrefsSnapshot {
  try {
    const raw = safeStorage.get(VOICE_CHAT_STORAGE_KEY);
    if (!raw) return sanitizeVoiceChatPrefs(null);
    return sanitizeVoiceChatPrefs(JSON.parse(raw) as Partial<VoiceChatPrefsSnapshot>);
  } catch {
    return sanitizeVoiceChatPrefs(null);
  }
}

export function saveVoiceChatPrefs(prefs: VoiceChatPrefsSnapshot): void {
  try {
    safeStorage.set(VOICE_CHAT_STORAGE_KEY, JSON.stringify(sanitizeVoiceChatPrefs(prefs)));
  } catch {
    // Ignore storage quota failures
  }
}
