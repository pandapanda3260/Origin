export type CreatorProfile = {
  visualStyle: string;
  narrativeStyle: string;
  cameraStyle: string;
  cameraPrefs: string;
  moodStyle: string;
  moodTone: string;
  promptHabits: string;
  duration: string;
  freeText: string;
  rawDialog: Array<{ role: string; content: string }>;
  updatedAt: string | null;
  lastUpdated: string | null;
};

export const DEFAULT_CREATOR_PROFILE: CreatorProfile = {
  visualStyle: '',
  narrativeStyle: '',
  cameraStyle: '',
  cameraPrefs: '',
  moodStyle: '',
  moodTone: '',
  promptHabits: '',
  duration: '',
  freeText: '',
  rawDialog: [],
  updatedAt: null,
  lastUpdated: null,
};

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeCreatorProfile(input: any): CreatorProfile {
  const raw = input && typeof input === 'object' ? input : {};
  const camera = str(raw.cameraStyle) || str(raw.cameraPrefs);
  const mood = str(raw.moodStyle) || str(raw.moodTone);
  const updatedAt = str(raw.updatedAt) || str(raw.lastUpdated) || null;
  const rawDialog = Array.isArray(raw.rawDialog) ? raw.rawDialog : [];

  return {
    ...DEFAULT_CREATOR_PROFILE,
    ...raw,
    visualStyle: str(raw.visualStyle),
    narrativeStyle: str(raw.narrativeStyle),
    cameraStyle: camera,
    cameraPrefs: camera,
    moodStyle: mood,
    moodTone: mood,
    promptHabits: str(raw.promptHabits),
    duration: str(raw.duration),
    freeText: str(raw.freeText),
    rawDialog,
    updatedAt,
    lastUpdated: updatedAt,
  };
}
