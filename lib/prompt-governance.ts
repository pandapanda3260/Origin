export type PromptFrameworkType =
  | 'system_base'
  | 'creative_heavy'
  | 'json_light'
  | 'compiler_heavy'
  | 'patch_protocol'
  | 'judge_light'
  | 'runtime_guardrail';

export type PromptModuleId =
  | 'commonRules'
  | 'scriptConsult'
  | 'scriptFullCreate'
  | 'scriptRevise'
  | 'styleBible'
  | 'retagEmotions'
  | 'assetCharactersExtract'
  | 'assetScenesExtract'
  | 'assetPropsExtract'
  | 'shotsGenerate'
  | 'storyboardImagePrompt'
  | 'videoPromptGenerate'
  | 'videoPromptRefine'
  | 'agentChat'
  | 'editAnalyze'
  | 'generateEdl'
  | 'continuityCheck'
  | 'imageRuntimeRules'
  | 'seedanceRuntimeRules';

export type PromptVersionStatus = 'stable' | 'candidate' | 'deprecated';

export type PromptVersionInfo = {
  schemaVersion: string;
  status: PromptVersionStatus;
};

export type PromptModuleDefinition = {
  moduleId: PromptModuleId;
  envKey: string;
  frameworkType: PromptFrameworkType;
  defaultVersion: string;
  versions: Record<string, PromptVersionInfo>;
  outputSchemaLocked?: boolean;
};

export const PROMPT_MODULES: Record<PromptModuleId, PromptModuleDefinition> = {
  commonRules: {
    moduleId: 'commonRules',
    envKey: 'COMMON_RULES',
    frameworkType: 'system_base',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' } },
  },
  scriptConsult: {
    moduleId: 'scriptConsult',
    envKey: 'SCRIPT_CONSULT',
    frameworkType: 'creative_heavy',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v0', status: 'candidate' } },
    outputSchemaLocked: true,
  },
  scriptFullCreate: {
    moduleId: 'scriptFullCreate',
    envKey: 'SCRIPT_FULL_CREATE',
    frameworkType: 'creative_heavy',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v0', status: 'candidate' } },
    outputSchemaLocked: true,
  },
  scriptRevise: {
    moduleId: 'scriptRevise',
    envKey: 'SCRIPT_REVISE',
    frameworkType: 'patch_protocol',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v0', status: 'candidate' } },
    outputSchemaLocked: true,
  },
  styleBible: {
    moduleId: 'styleBible',
    envKey: 'STYLE_BIBLE',
    frameworkType: 'json_light',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  retagEmotions: {
    moduleId: 'retagEmotions',
    envKey: 'RETAG_EMOTIONS',
    frameworkType: 'json_light',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  assetCharactersExtract: {
    moduleId: 'assetCharactersExtract',
    envKey: 'ASSET_CHARACTERS_EXTRACT',
    frameworkType: 'json_light',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  assetScenesExtract: {
    moduleId: 'assetScenesExtract',
    envKey: 'ASSET_SCENES_EXTRACT',
    frameworkType: 'json_light',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  assetPropsExtract: {
    moduleId: 'assetPropsExtract',
    envKey: 'ASSET_PROPS_EXTRACT',
    frameworkType: 'json_light',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  shotsGenerate: {
    moduleId: 'shotsGenerate',
    envKey: 'SHOTS_GENERATE',
    frameworkType: 'creative_heavy',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  storyboardImagePrompt: {
    moduleId: 'storyboardImagePrompt',
    envKey: 'STORYBOARD_IMAGE_PROMPT',
    frameworkType: 'compiler_heavy',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v0', status: 'candidate' } },
    outputSchemaLocked: true,
  },
  videoPromptGenerate: {
    moduleId: 'videoPromptGenerate',
    envKey: 'VIDEO_PROMPT_GENERATE',
    frameworkType: 'compiler_heavy',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v0', status: 'candidate' } },
    outputSchemaLocked: true,
  },
  videoPromptRefine: {
    moduleId: 'videoPromptRefine',
    envKey: 'VIDEO_PROMPT_REFINE',
    frameworkType: 'patch_protocol',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v0', status: 'candidate' } },
    outputSchemaLocked: true,
  },
  agentChat: {
    moduleId: 'agentChat',
    envKey: 'AGENT_CHAT',
    frameworkType: 'patch_protocol',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v0', status: 'candidate' } },
    outputSchemaLocked: true,
  },
  editAnalyze: {
    moduleId: 'editAnalyze',
    envKey: 'EDIT_ANALYZE',
    frameworkType: 'judge_light',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  generateEdl: {
    moduleId: 'generateEdl',
    envKey: 'GENERATE_EDL',
    frameworkType: 'compiler_heavy',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  continuityCheck: {
    moduleId: 'continuityCheck',
    envKey: 'CONTINUITY_CHECK',
    frameworkType: 'judge_light',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  imageRuntimeRules: {
    moduleId: 'imageRuntimeRules',
    envKey: 'IMAGE_RUNTIME_RULES',
    frameworkType: 'runtime_guardrail',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
  seedanceRuntimeRules: {
    moduleId: 'seedanceRuntimeRules',
    envKey: 'SEEDANCE_RUNTIME_RULES',
    frameworkType: 'runtime_guardrail',
    defaultVersion: 'legacy',
    versions: { legacy: { schemaVersion: 'v0', status: 'stable' }, v1: { schemaVersion: 'v1', status: 'candidate' } },
  },
};

export type PromptVersionContext = {
  userId?: number | string | null;
  projectId?: string | null;
};

export type PromptVersionResolution = {
  moduleId: PromptModuleId;
  activeVersion: string;
  schemaVersion: string;
  frameworkType: PromptFrameworkType;
  source: 'module-default' | 'env-default' | 'env-user' | 'env-project' | 'json-default' | 'json-user' | 'json-project' | 'invalid-fallback';
  warnings: string[];
};

type PromptVersionOverride = {
  defaultVersion?: string;
  users?: Record<string, string>;
  projects?: Record<string, string>;
};

type PromptVersionConfigJson = {
  modules?: Partial<Record<PromptModuleId, PromptVersionOverride>>;
} & Partial<Record<PromptModuleId, PromptVersionOverride>>;

export type PromptModelConfigRef = {
  modelRole: string;
  configKey: string;
  configVersionHash?: string;
};

export type PromptFailureLevel = 'hard' | 'soft' | 'preference';

export type PromptEvalSample = {
  caseId: string;
  moduleId: PromptModuleId;
  failureLevel: PromptFailureLevel;
  failureTags: string[];
  inputSnapshot: unknown;
  oldOutput: unknown;
  humanFixSummary?: string;
  promptVersion: string;
  schemaVersion?: string;
  modelConfigRef?: PromptModelConfigRef;
  createdAt: string;
};

export type PromptAutoMetrics = {
  jsonOk?: boolean;
  requiredFieldCompleteness?: number;
  schemaOk?: boolean;
  outputCharCount?: number;
  latencyMs?: number;
  retryCount?: number;
  errorType?: string;
};

export type PromptLeakScan = {
  hasLeak: boolean;
  severity: 'none' | 'low' | 'high';
  matches: Array<{ keyword: string; index: number }>;
};

export type PromptHumanRating = {
  canProceed: boolean;
  failureLevel?: PromptFailureLevel;
  editAmount?: 'none' | 'minor' | 'major' | 'rewrite';
  notes?: string;
};

export type PromptComparisonSummary = {
  comparableCases: number;
  winRate: number;
  lossRate: number;
  tieRate: number;
  hardFailureDelta: number;
  leakDelta: number;
  outputCharDelta: number;
  outputCharP95Delta: number;
  latencyDelta: number;
  latencyP95Delta: number;
};

export type PromptEvalResult = {
  caseId: string;
  moduleId: PromptModuleId;
  candidatePromptVersion: string;
  autoMetrics: PromptAutoMetrics;
  leakScan: PromptLeakScan;
  humanRating?: PromptHumanRating;
  comparison?: PromptComparisonSummary;
  notes?: string;
};

export type PromptLeakKeywordFixture = {
  moduleId: PromptModuleId | 'default';
  appliesTo: Array<'json' | 'plain-description' | 'script' | 'video-prompt'>;
  highRisk: string[];
  lowRisk: string[];
  allowlist?: string[];
};

export type PromptFewShotFixture = {
  moduleId: PromptModuleId;
  schemaVersion: string;
  examples: Array<{
    id: string;
    coversFailureTags: string[];
    input: unknown;
    output: unknown;
  }>;
};

function parseOverrideMap(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rawKey, rawVersion] = trimmed.split('=');
    const key = (rawKey || '').trim();
    const version = (rawVersion || '').trim();
    if (key && version) out[key] = version;
  }
  return out;
}

function parseJsonConfig(raw: string | undefined): PromptVersionConfigJson {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function jsonOverrideFor(moduleId: PromptModuleId, jsonConfig: PromptVersionConfigJson): PromptVersionOverride {
  return {
    ...((jsonConfig[moduleId] || {}) as PromptVersionOverride),
    ...((jsonConfig.modules?.[moduleId] || {}) as PromptVersionOverride),
  };
}

function validateVersion(def: PromptModuleDefinition, selected: string, warnings: string[]): string {
  if (def.versions[selected]) return selected;
  warnings.push(`Unknown prompt version "${selected}" for ${def.moduleId}; falling back to ${def.defaultVersion}.`);
  return def.defaultVersion;
}

export function resolvePromptVersion(
  moduleId: PromptModuleId,
  context: PromptVersionContext = {},
  env: NodeJS.ProcessEnv = process.env,
): PromptVersionResolution {
  const def = PROMPT_MODULES[moduleId];
  const warnings: string[] = [];
  const baseKey = `PROMPT_VERSION_${def.envKey}`;
  const jsonConfig = parseJsonConfig(env.PROMPT_VERSION_CONFIG_JSON);
  const jsonOverride = jsonOverrideFor(moduleId, jsonConfig);

  const envDefault = env[baseKey]?.trim();
  const envUsers = parseOverrideMap(env[`${baseKey}_USERS`]);
  const envProjects = parseOverrideMap(env[`${baseKey}_PROJECTS`]);
  const userKey = context.userId == null ? '' : String(context.userId);
  const projectKey = context.projectId || '';

  let selected = def.defaultVersion;
  let source: PromptVersionResolution['source'] = 'module-default';

  if (envDefault) {
    selected = envDefault;
    source = 'env-default';
  }
  if (jsonOverride.defaultVersion) {
    selected = jsonOverride.defaultVersion;
    source = 'json-default';
  }
  if (userKey && envUsers[userKey]) {
    selected = envUsers[userKey];
    source = 'env-user';
  }
  if (userKey && jsonOverride.users?.[userKey]) {
    selected = jsonOverride.users[userKey];
    source = 'json-user';
  }
  if (projectKey && envProjects[projectKey]) {
    selected = envProjects[projectKey];
    source = 'env-project';
  }
  if (projectKey && jsonOverride.projects?.[projectKey]) {
    selected = jsonOverride.projects[projectKey];
    source = 'json-project';
  }

  const validated = validateVersion(def, selected, warnings);
  if (validated !== selected) source = 'invalid-fallback';
  const versionInfo = def.versions[validated] || def.versions[def.defaultVersion];

  return {
    moduleId,
    activeVersion: validated,
    schemaVersion: versionInfo.schemaVersion,
    frameworkType: def.frameworkType,
    source,
    warnings,
  };
}
