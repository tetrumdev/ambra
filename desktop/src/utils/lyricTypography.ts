import type { LyricLine } from "../types/lyrics";

/** Stack Sans draws the neutral ASCII double quote like a closing quote. Choose its
 * directional glyph from the whole line, before splitting it into timed words/letters.
 * Replacements have the same length, so segment boundaries and timing stay intact.
 */
export function lyricDisplayLine(line: LyricLine): LyricLine {
  if (!line.text.includes('"')) return line;
  let quoted = false;
  const text = line.text.replace(/["“”]/g, (mark, offset: number) => {
    if (mark !== '"') {
      quoted = mark === "“";
      return mark;
    }
    const before = line.text[offset - 1];
    const after = line.text[offset + 1];
    // Measurements such as 12" records aren't quotations.
    if (!quoted && before && /\d/u.test(before)) return mark;
    const opening = (!before || /\s/u.test(before) || "([{—–:".includes(before))
      && after !== undefined && !/\s/u.test(after);
    quoted = opening;
    return opening ? "“" : "”";
  });
  let offset = 0;
  const segments = line.segments.map(segment => {
    const next = text.slice(offset, offset + segment.text.length);
    offset += segment.text.length;
    return next === segment.text ? segment : { ...segment, text: next };
  });
  return { ...line, text, segments };
}
