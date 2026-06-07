import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/modules/subtitle_format.js', import.meta.url), 'utf8');
const subtitleFormat = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`);

const {
  extractSubtitleLinesFromPrompt,
  formatSubtitleDisplayText,
  resolveSubtitleLayoutSpec,
  splitSubtitleDialogueLines,
  subtitleVisibleCharCount,
} = subtitleFormat;

assert.deepEqual(
  splitSubtitleDialogueLines('老板："明天翻倍。" 帝王蟹：—— 波龙：「我——我不知道。」'),
  ['明天翻倍', '我——我不知道'],
  'speaker prefixes should be removed, placeholder dashes skipped, and middle dashes preserved',
);

assert.deepEqual(splitSubtitleDialogueLines('——'), [], 'plain placeholder dashes should produce no subtitle');
assert.deepEqual(splitSubtitleDialogueLines('老板：——'), [], 'speaker placeholder dashes should produce no subtitle');

assert.equal(formatSubtitleDisplayText('——我不知道——'), '我不知道', 'edge dashes should be stripped');
assert.equal(formatSubtitleDisplayText('我——我不知道。'), '我——我不知道', 'middle dashes should be preserved');
assert.equal(formatSubtitleDisplayText('老板：“明天翻倍。”'), '明天翻倍', 'leftover speaker prefix should be stripped');
assert.equal(formatSubtitleDisplayText('一届不如一届，难道我混沌圣地真要就此没落……'), '一届不如一届，\n难道我混沌圣地真要就此没落', 'mechanical trailing ellipsis should be stripped');
assert.equal(formatSubtitleDisplayText('系统发布的第一个任务——进入混沌圣地。我等了十六年.'), '系统发布的第一个任务——\n进入混沌圣地。我等了十六年', 'middle dashes should stay while trailing ascii periods are stripped');
assert.equal(formatSubtitleDisplayText('”'), '', 'quote-only fragments should not render as subtitles');
assert.deepEqual(splitSubtitleDialogueLines('萧云：”'), [], 'speaker quote-only fragments should be skipped');
assert.equal(formatSubtitleDisplayText('"萧云"'), '萧云', 'valid quoted dialogue should keep the inner text');

assert.deepEqual(
  extractSubtitleLinesFromPrompt('镜头 01\n老板：“明天翻倍。”\n帝王蟹：「先别画饼，手酸。」'),
  ['明天翻倍', '先别画饼，手酸'],
  'prompt extraction should keep text only and remove weak final punctuation',
);

const wrapped = formatSubtitleDisplayText('这是一个比较长的字幕句子，应该分成两行显示', { maxLineChars: 12 }).split('\n');
assert.equal(wrapped.length, 2, 'long subtitle should wrap to two lines');
assert.ok(!/^[，、。！？；：）」』”]/.test(wrapped[1]), 'second line should not start with closing punctuation');
assert.ok(!/[「『“（《]$/.test(wrapped[0]), 'first line should not end with opening punctuation');

assert.equal(subtitleVisibleCharCount('明天\n翻倍'), 4, 'visible char count should ignore wrapping whitespace');

const portraitLayout = resolveSubtitleLayoutSpec({ width: 1080, height: 1920 });
assert.equal(portraitLayout.orientation, 'portrait');
assert.equal(portraitLayout.topRatio, 0.72, 'portrait subtitles should sit around 70-75% from the top');
assert.equal(portraitLayout.maxWidthRatio, 0.84, 'subtitle max width should preserve horizontal safe margins');

const landscapeLayout = resolveSubtitleLayoutSpec({ width: 1920, height: 1080 });
assert.equal(landscapeLayout.orientation, 'landscape');
assert.equal(landscapeLayout.topRatio, 0.85, 'landscape subtitle top should sit around 85% from the top');

console.log('test-subtitle-format: ok');
