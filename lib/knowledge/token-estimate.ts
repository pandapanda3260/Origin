/**
 * P1 Lite uses a dependency-free rough estimate for promptBlock only.
 * Chinese characters are counted close to 1 token each; ASCII runs are
 * approximated at 4 chars/token. P2 can replace this with provider-specific
 * tokenizers when selective injection is actually enabled.
 */
export function estimatePromptBlockTokens(text: string): number {
  const input = String(text || '');
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
    }
  };
  for (const ch of input) {
    if (/\s/.test(ch)) {
      flushAscii();
      continue;
    }
    if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      flushAscii();
      tokens += 1;
    } else {
      asciiRun += 1;
    }
  }
  flushAscii();
  return tokens;
}
