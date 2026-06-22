import type Database from 'better-sqlite3';

type SystemCardSeed = {
  id: string;
  module: string;
  cardType: string;
  title: string;
  priority: number;
  tags?: string[];
  data: Record<string, unknown>;
  sourceRef?: Record<string, unknown>;
  schemaVersion?: number;
  version?: number;
};

const SYSTEM_CARDS: SystemCardSeed[] = [
  {
    id: 'sys-narrative-short-video-structure',
    module: 'narrative_structure',
    cardType: 'story_structure_rule',
    title: '短视频叙事节拍优先服务冲突和反转',
    priority: 20,
    tags: ['stage:script_create', 'stage:shots_generate', 'stage:edit_analyze', 'stage:edit_edl'],
    data: {
      hardRules: [
        '剧本和镜头拆解必须围绕开场钩子、冲突推进、反转、高潮和余韵组织信息。',
        '台词不承担解释设定的功能，优先推动关系、目标或冲突变化。',
        '剪辑分析和 EDL 应保留故事因果链，不为节奏牺牲关键承接信息。',
      ],
    },
    sourceRef: { files: ['lib/prompts.ts', 'lib/edit-analyze.ts', 'lib/edit-edl.ts'] },
  },
  {
    id: 'sys-style-bible-template-anchors',
    module: 'style_bible',
    cardType: 'style_template_anchor',
    title: '风格模板锚点不被 AI 重写',
    priority: 20,
    tags: ['stage:style_bible'],
    data: {
      content: '生成风格圣经时必须保留已选 style template 的色彩、镜头、光线、材质、负向约束等锚点；AI 只能补全项目级表达，不应覆盖模板锚点。',
    },
    sourceRef: { files: ['lib/style-template-constraints.ts', 'app/api/script/workflow/extract-style-bible/route.ts'] },
  },
  {
    id: 'sys-assets-world-identity-dedupe',
    module: 'asset_extraction',
    cardType: 'asset_identity_rule',
    title: '资产抽取优先复用世界观候选与角色锁',
    priority: 30,
    tags: ['stage:assets_extract'],
    data: {
      content: '抽取角色、场景、道具时优先匹配 world template 中的候选项和项目 consistency lock，避免同一角色重复命名或临时资产污染后续流程。',
    },
    sourceRef: { files: ['lib/world-template-context.ts', 'lib/character-consistency.ts'] },
  },
  {
    id: 'sys-identity-lock-runtime',
    module: 'identity_consistency',
    cardType: 'identity_lock',
    title: '角色一致性锁是项目级权威身份知识',
    priority: 10,
    tags: ['stage:video_prompt', 'stage:assets_extract'],
    data: {
      hardRules: [
        '角色 identityLock / visualLock / performanceLock / voiceLock 是当前项目生成链路的权威约束。',
        '下游首帧、视频 Prompt、视频提交不得改写角色身份、外观签名、声音和表演特征。',
      ],
    },
    sourceRef: { files: ['lib/character-consistency.ts', 'lib/character-consistency-gate.ts'] },
  },
  {
    id: 'sys-shot-design-single-shot-strict',
    module: 'shot_design',
    cardType: 'shot_design_rule',
    title: '镜头设计：逐镜头独立，短镜头交由片段合并',
    priority: 20,
    tags: ['stage:shots_generate'],
    data: {
      hardRules: [
        '镜头生成阶段逐个输出"镜头(shot)"。相邻撑不满 Seedance 生成下限(4 秒)的短镜头，会在镜头计划阶段被自动合并成一个"片段(storyboard)"、一次生成——所以一个片段可对应多个镜头，不再是"一个 storyboard = 一个镜头"。',
        '该快的节拍大胆给 1-2 秒短镜头(单镜头时长区间 1-7 秒)，不要为了凑生成时长把镜头拉长；不足 4 秒的短镜头会被合并、不会被单独顶时长。',
        '每个镜头只承载一个核心动作/节拍与一套控制参数(景别/角度/焦距/景深/光线/构图/运镜)，不把多个时间段塞进同一个镜头描述。',
        '镜头数量与时长贴合剧本节拍，不为凑镜头破坏台词完整性。',
      ],
    },
    sourceRef: { files: ['lib/prompts.ts', 'app/api/shots/generate/route.ts'] },
  },
  {
    id: 'sys-storyboard-first-frame-prompt',
    module: 'storyboard_prompt',
    cardType: 'storyboard_prompt_rule',
    title: '分镜提示词生成真实视频首帧而非概念图',
    priority: 20,
    tags: ['stage:storyboard_sketch_prompt'],
    data: {
      hardRules: [
        'storyboard image prompt 应描述视频 t=0 的真实画面，不生成海报、概念设计或多格漫画。',
        '首帧必须锁定本镜头角色、场景、道具和项目风格圣经，不引入剧本外元素。',
        '提示词要优先表达主体位置、景别、光线、动作起点和画幅构图。',
      ],
    },
    sourceRef: { files: ['app/api/storyboard/convert-prompt/route.ts', 'lib/batch-executors.ts'] },
  },
  {
    id: 'sys-frame-image-reference-budget',
    module: 'frame_image',
    cardType: 'frame_image_rule',
    title: '首尾帧生成遵守参考图预算和连续性边界',
    priority: 20,
    tags: ['stage:first_frame_image', 'stage:tail_frame_image'],
    data: {
      hardRules: [
        '首帧参考图预算为 4，视频参考图预算为 7，两者不可混用。',
        '首帧描述应锁定镜头起点；尾帧描述应保持与首帧的场景、服装、道具和光线连续性。',
        '参考图只作为身份、场景或道具约束，不允许覆盖当前镜头动作和构图。',
      ],
    },
    sourceRef: { files: ['lib/frame-image-plan.ts', 'lib/video-reference-manifest.ts'] },
  },
  {
    id: 'sys-video-prompt-dialogue-verbatim',
    module: 'video_prompt',
    cardType: 'dialogue_integrity',
    title: '视频 Prompt 必须逐字保留台词',
    priority: 10,
    tags: ['stage:video_prompt', 'stage:video_prompt_refine'],
    data: {
      hardRules: [
        '视频 Prompt 生成和精修不得改写、删减或重排原台词。',
        '参考图编号只允许使用 Image N 形式，且不得编造不存在的编号。',
        'P0 阶段该规则只写审计上下文，原 prompts.ts 硬约束继续兜底。',
      ],
    },
    sourceRef: { files: ['lib/prompts.ts', 'lib/video-reference-manifest.ts'] },
  },
  {
    id: 'sys-video-prompt-refine-immutable-facts',
    module: 'video_prompt_refine',
    cardType: 'refine_guard_rule',
    title: '视频 Prompt 精修默认保留不可变事实',
    priority: 10,
    tags: ['stage:video_prompt_refine'],
    data: {
      hardRules: [
        '普通精修必须保留时间段标题顺序、Image N 编号、角色身份和台词事实。',
        '敏感词替换使用 guardMode=off 的专用路径，只允许词级替换，不扩写、不删段。',
        'SSE 流结束后以后置校验结果决定是否接受，失败时前端回退 previousPrompt。',
      ],
    },
    sourceRef: { files: ['app/api/video-prompt/refine/route.ts', 'lib/knowledge/refine-output-guard.ts'] },
  },
  {
    id: 'sys-provider-runtime-seedance-dialogue',
    module: 'provider_runtime',
    cardType: 'provider_hard_rule',
    title: 'Seedance 视频提交台词与声音硬约束',
    priority: 10,
    tags: ['provider:seedance', 'stage:video_submit'],
    data: {
      hardRules: [
        'Seedance 提交前必须保留台词原文，不允许把角色名读成旁白。',
        '参考图与首帧连续性约束由现有 video-gen runtime 继续执行，P0 只记录审计。',
      ],
    },
    sourceRef: { files: ['lib/video-gen.ts'] },
  },
  {
    id: 'sys-provider-runtime-generic-reference-budget',
    module: 'provider_runtime',
    cardType: 'provider_reference_rule',
    title: '通用参考图编号与数量约束',
    priority: 40,
    tags: ['provider:generic', 'stage:video_submit', 'stage:video_prompt'],
    data: {
      hardRules: [
        '视频参考图清单使用 Image 1 / Image 2 这类稳定编号。',
        'feature flag 与运行模式不进入知识卡，只进入项目阶段审计快照。',
      ],
    },
    sourceRef: { files: ['lib/video-reference-manifest.ts', 'lib/frame-workflow-state.ts'] },
  },
  {
    id: 'sys-scene-view-quality-rubric',
    module: 'scene_view_quality',
    cardType: 'visual_quality_rubric',
    title: '场景多视图评分只判断同一物理空间',
    priority: 10,
    tags: ['stage:asset_images', 'scene_view_quality'],
    data: {
      content: '评估 reverse / alt / topdown 时，只判断候选图是否能作为 establishing 的同一物理空间视图使用；有 topdown 布局锚时必须利用它检查相对位置和朝向，不评价美术好坏。',
      hardRules: [
        '同风格、同色调、同题材不等于同一空间；必须能追踪核心空间锚点。',
        '至少检查中心物、入口/出口、台阶/墙体/地面区域、大型道具、主轴线或朝向中的多个稳定锚点。',
        '当评分输入包含 topdown 布局锚时，reverse / alt 候选图里的中心物、入口、主轴线、地面区域和大型结构必须能被该俯视布局解释。',
        'reverse 必须像同一空间的反打/回看，不得只是另一个类似广场或房间。',
        'alt 必须像同一空间的侧角/细节机位，不得改掉关键入口、中心物和大结构。',
        'topdown 必须是可读的俯视/高机位布局锚，不是普通概念图、眼平图或装饰性插画。',
      ],
      scoreFields: [
        'sceneIdentityScore: 是否还是同一个地点/空间身份。',
        'spatialLayoutScore: 关键空间锚点和相对位置是否能对应。',
        'viewRoleScore: 候选图是否满足 reverse / alt / topdown 的角色。',
        'visualContinuityScore: 材质、光线、天气、色彩、年代感是否一致。',
        'promptComplianceScore: 是否符合 scene metadata 和原始场景提示词。',
      ],
      outputSchema: '{"score":0-100,"sceneIdentityScore":0-100,"spatialLayoutScore":0-100,"viewRoleScore":0-100,"visualContinuityScore":0-100,"promptComplianceScore":0-100,"reasons":["..."],"retryPromptHint":"..."}',
    },
    sourceRef: { files: ['lib/scene-view-quality.ts', 'lib/batch-executors.ts'] },
  },
  {
    id: 'sys-edit-dialogue-preservation',
    module: 'edit_strategy',
    cardType: 'edit_integrity',
    title: '剪辑阶段保留对白完整性',
    priority: 20,
    tags: ['stage:edit_analyze', 'stage:edit_edl'],
    data: {
      content: 'AI 剪辑分析和 EDL 生成应保留关键台词与叙事因果，避免为了节奏切断一句话或删除承接信息。',
    },
    sourceRef: { files: ['lib/edit-analyze.ts', 'lib/edit-edl.ts'] },
  },
  {
    id: 'sys-audio-subtitle-export-defaults',
    module: 'audio_subtitle_export',
    cardType: 'export_default_rule',
    title: '导出阶段统一音频、字幕和平台规格默认值',
    priority: 20,
    tags: ['stage:export'],
    data: {
      hardRules: [
        '导出阶段以时间线 EDL 为事实来源，BGM、字幕和转场音效只做呈现层配置。',
        '字幕必须遵守安全区、最小时长和单行长度限制，避免遮挡主体和 UI。',
        'BGM 匹配优先按情绪、节奏和片段标签选择，默认音量不得压过对白。',
      ],
    },
    sourceRef: { files: ['lib/edit-export.ts', 'app/api/edit/bgm-library/route.ts'] },
  },
];

export function seedSystemCards(db: Database.Database) {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO knowledge_cards
       (id, owner_id, scope, module, card_type, title, status, lifecycle, priority,
        tags_json, data_json, source_ref_json, schema_version, version, published_at, published_by,
        seeded_at, created_at, updated_at)
     VALUES
       (?, NULL, 'system', ?, ?, ?, 'active', 'published', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    const ids: string[] = [];
    for (const card of SYSTEM_CARDS) {
      ids.push(card.id);
      stmt.run(
        card.id,
        card.module,
        card.cardType,
        card.title,
        card.priority,
        JSON.stringify(card.tags || []),
        JSON.stringify(card.data),
        JSON.stringify(card.sourceRef || {}),
        card.schemaVersion || 1,
        card.version || 1,
        now,
        now,
        now,
        now,
      );
    }
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `UPDATE knowledge_cards
         SET published_at = COALESCE(published_at, seeded_at, created_at)
         WHERE scope = 'system'
           AND lifecycle = 'published'
           AND id IN (${placeholders})`,
      ).run(...ids);
    }
  });
  tx();
}
