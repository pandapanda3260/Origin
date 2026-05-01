/**
 * styleBible 后处理工具集。
 *
 * 主要解决 LLM 偷懒输出英文色名（TEAL / AMBER / CREAM 等）导致前端
 * 色卡显示一串大写英文的问题。这里提供：
 *   - 常见英文色 → 中文映射表（70+ 词）
 *   - 未知英文色按 hex 猜中文兜底
 *   - sinicizeColorPalette(sb)：直接吃 styleBible 对象，原地翻新 colorPalette
 */

const COLOR_EN_TO_CN: Record<string, string> = {
  TEAL: '青蓝', AMBER: '琥珀黄', CORAL: '珊瑚红', CREAM: '奶油白',
  CHARCOAL: '炭灰', CRIMSON: '绛红', GOLD: '鎏金', SILVER: '银灰',
  OCEAN: '深海蓝', SKY: '天蓝', NAVY: '藏蓝', MIDNIGHT: '夜墨',
  IVORY: '象牙白', BEIGE: '米色', SAND: '沙黄', SAGE: '鼠尾草绿',
  OLIVE: '橄榄绿', FOREST: '森绿', JADE: '翡翠绿', MINT: '薄荷绿',
  EMERALD: '祖母绿', TURQUOISE: '松石绿', INDIGO: '靛青', VIOLET: '紫罗兰',
  LAVENDER: '薰衣草紫', PLUM: '梅紫', BURGUNDY: '勃艮第红', SCARLET: '猩红',
  RUBY: '宝石红', ROSE: '玫粉', BLUSH: '腮红粉', PEACH: '桃粉',
  APRICOT: '杏色', RUST: '铁锈红', BRICK: '砖红', TERRACOTTA: '陶土',
  CHESTNUT: '栗棕', MOCHA: '摩卡', COFFEE: '咖色', CARAMEL: '焦糖',
  HONEY: '蜜糖黄', LEMON: '柠檬黄', MUSTARD: '芥末黄', BUTTER: '奶黄',
  COPPER: '紫铜', BRONZE: '青铜', SLATE: '石板灰', GRAPHITE: '石墨灰',
  ASH: '烟灰', SMOKE: '雾灰', STORM: '风暴灰', FOG: '雾蓝',
  SNOW: '雪白', PEARL: '珍珠白', BONE: '骨白', LINEN: '亚麻',
  TAUPE: '灰褐', CAMEL: '驼色', KHAKI: '卡其', WALNUT: '胡桃棕',
  EBONY: '乌木黑', JET: '墨黑', ONYX: '玛瑙黑', BLACK: '纯黑',
  WHITE: '纯白', GRAY: '中灰', GREY: '中灰',
};

/** 把 styleBible.colorPalette 里偷懒输出的英文色名翻成中文（原地修改） */
export function sinicizeColorPalette<T extends { colorPalette?: any }>(sb: T): T {
  if (!sb || typeof sb !== 'object') return sb;
  if (!Array.isArray(sb.colorPalette)) return sb;
  sb.colorPalette = sb.colorPalette.map((c: any, i: number) => {
    if (!c || typeof c !== 'object') return c;
    const raw = String(c.name || '').trim();
    // 已经含中文就别动
    if (/[\u4e00-\u9fff]/.test(raw)) return c;
    if (!raw) return { ...c, name: `主色 ${i + 1}` };
    const upper = raw.toUpperCase();
    const cn = COLOR_EN_TO_CN[upper];
    if (cn) return { ...c, name: cn };
    // 未知英文色名 → 按 hex 颜色家族猜一个
    const hex = String(c.hex || '').toLowerCase();
    return { ...c, name: guessChineseFromHex(hex) || `辅色 ${i + 1}` };
  });
  return sb;
}

function guessChineseFromHex(hex: string): string {
  const m = hex.match(/^#?([0-9a-f]{6})$/);
  if (!m) return '';
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  if (max - min < 20) {
    if (lightness > 220) return '雪白';
    if (lightness > 170) return '浅灰';
    if (lightness > 90) return '中灰';
    if (lightness > 40) return '深灰';
    return '墨黑';
  }
  if (r > g && r > b) return b > g ? '玫红' : '砖红';
  if (g > r && g > b) return r > b ? '橄榄绿' : '青绿';
  if (b > r && b > g) return r > g ? '紫罗兰' : '深蓝';
  if (r > 200 && g > 150) return '暮霞橙';
  return '主色调';
}
