export const MOCK_USER_SETTINGS = {
  models: {
    text: { provider: 'openai', baseUrl: '', apiKey: '', model: 'gpt-4o-mini' },
    image: { provider: 'nano-banana', baseUrl: '', apiKey: '', model: 'nano-banana' },
    video: { provider: 'seedance', baseUrl: '', apiKey: '', model: 'Seedance' },
    storyboard: { provider: 'nano-banana', baseUrl: '', apiKey: '', model: 'nano-banana' },
  },
  preferences: {
    visualStyle: '',
    narrativeStyle: '',
    cameraStyle: '',
    moodStyle: '',
    promptHabits: '',
  },
  updatedAt: null as string | null,
};
