import { recommendFeaturedStyleTemplateIdForScript } from '../lib/style-templates-db';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function pick(script: string) {
  return recommendFeaturedStyleTemplateIdForScript({ script }).id;
}

assertEqual(
  pick('当代中国城市夜晚，转锅牛杂店门外霓虹招牌闪烁，老板和顾客围绕传送带发生冲突。'),
  'style_live_action_realistic',
  'modern grounded urban story should use live-action realistic',
);

assertEqual(
  pick('宗门大比之夜，少年催动灵气御剑飞升，魔尊在云海中召出上古神兽。'),
  'style_3d_xuanhuan',
  'xuanhuan cultivation story should use 3D xuanhuan',
);

assertEqual(
  pick('混沌圣地广场，灰袍接引长老盘膝而坐，萧云听见系统奖励三次顿悟，虚空裂隙在山门外闭合，妖孽天骄陆续登台。'),
  'style_3d_xuanhuan',
  'xuanhuan sect story with neon-like metaphor should use 3D xuanhuan',
);

assertEqual(
  pick('皇宫夜宴，王爷与将军在朝堂权谋中交锋，刺客潜入宫墙。'),
  'style_live_action_costume',
  'ancient court story should use live-action costume',
);

assertEqual(
  pick('特工在高速公路追车，枪战后引爆大桥，军队展开灾难救援。'),
  'style_hollywood_blockbuster',
  'action explosion story should use Hollywood blockbuster',
);

assertEqual(
  pick('儿童校园轻喜剧，可爱小学生和会说话的书包每天制造搞笑误会。'),
  'style_2d_animation',
  'cute comedy story should use 2D animation',
);

assertEqual(
  pick('夏天海边的治愈动画电影，少年在梦境和回忆中寻找温柔告别。'),
  'style_2d_movie',
  'healing animated film story should use 2D movie',
);

assertEqual(
  pick('未来太空基地失控，机器人与机甲在废土城市追踪人工智能核心。'),
  'style_3d_realistic',
  'sci-fi CG story should use realistic 3D',
);

assertEqual(
  pick('深夜吴家客厅，水晶吊灯惨白刺眼，落地窗外广告牌循环播放幸福之家，Eva指控Jason婚内出轨。'),
  'style_live_action_realistic',
  'modern domestic revenge drama should use live-action realistic',
);

console.log('style-template recommendation tests passed');
