import type { Track } from "../types/music";

/**
 * Text matching for search: how well a song, album or artist answers what was typed.
 *
 * A query is a bag of words. Each word is looked for in the title, the credited artists, the
 * version notes and the album, however the service spells them ("C.L." for "CL", "4 Hero" for
 * "4hero", "Kirks" for "Kirk's"). The score is how much of the query the entry explains, then
 * how much of the entry's own title and artist the query names.
 */

/** Words that say little: missing or unmatched, they barely move a score. */
const MINOR = new Set(["and", "the", "a", "an", "of", "feat", "ft", "featuring", "with", "by", "x", "vs"]);
/** Words pasted along with a song's name from a video title. */
const NOISE = new Set(["clean", "explicit", "official", "video", "audio", "lyrics", "lyric", "hd", "hq", "4k", "visualizer", "visualiser", "mv"]);

/**
 * Lowercase words without accents or punctuation. Dotted initials join ("T.R.O.Y." is "troy",
 * "C.L." is "cl") and apostrophes vanish ("Kirk's" is "kirks"), so each spelling is one word.
 * Symbols standing in for letters read as them: "A$AP" is "asap", "P!nk" is "pink".
 */
export function fold(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/['’‘`´]/g, "")
    .replace(/\$(?=\p{L})|(?<=\p{L})\$/gu, "s").replace(/(?<=\p{L})!(?=\p{L})/gu, "i")
    .replace(/\b(?:\p{L}\.){2,}(?:\p{L}\b)?/gu, initials => initials.replace(/\./g, ""))
    .replace(/&|\+/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function foldTokens(value: string) {
  const text = fold(value);
  return text ? text.split(" ") : [];
}

function distance(a: string, b: string, limit: number) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = row;
  }
  return previous[b.length];
}

/** How alike two words are: the same, the start of one being typed, or a letter or two apart. */
function similarity(typed: string, word: string, typing: boolean) {
  if (typed === word) return 1;
  if (typing && typed.length >= 2 && word.startsWith(typed)) return 0.85;
  // Numbers are never near misses: 1998 is not 1999.
  if (typed.length < 4 || word.length < 4 || !/\p{L}/u.test(typed)) return 0;
  const limit = Math.min(typed.length, word.length) >= 8 ? 2 : 1;
  return distance(typed, word, limit) <= limit ? 0.9 : 0;
}

/**
 * Matches the typed words against a field's words. `found[i]` is how well each typed word was
 * found and `at[i]` where; `used[j]` how well each of the field's words was asked for. Words
 * written together on one side and apart on the other ("4hero", "4 Hero") match as one.
 */
function matchWords(typed: string[], words: string[]) {
  const found = typed.map(() => 0), at = typed.map(() => -1), used = words.map(() => 0);
  const find = (i: number, j: number, score: number) => {
    if (score > found[i]) { found[i] = score; at[i] = j; }
    if (score > used[j]) used[j] = score;
  };
  for (let i = 0; i < typed.length; i++) {
    for (let j = 0; j < words.length; j++) {
      find(i, j, similarity(typed[i], words[j], i === typed.length - 1));
      if (j + 1 < words.length && words[j] + words[j + 1] === typed[i]) {
        find(i, j, 0.95);
        find(i, j + 1, 0.95);
      }
      if (i + 1 < typed.length && typed[i] + typed[i + 1] === words[j]) {
        find(i, j, 0.95);
        find(i + 1, j, 0.95);
      }
    }
  }
  return { found, at, used };
}

const weight = (word: string) => NOISE.has(word) ? 0.1 : MINOR.has(word) ? 0.15 : 1;

function share(words: string[], used: number[]) {
  let total = 0, matched = 0;
  for (let i = 0; i < words.length; i++) {
    total += weight(words[i]);
    matched += weight(words[i]) * used[i];
  }
  return total ? matched / total : 0;
}

type Query = { words: string[]; total: number };
const queries = new Map<string, Query>();

function parse(query: string): Query {
  let parsed = queries.get(query);
  if (!parsed) {
    const words = foldTokens(query);
    parsed = { words, total: words.reduce((sum, word) => sum + weight(word), 0) };
    if (queries.size > 50) queries.clear();
    queries.set(query, parsed);
  }
  return parsed;
}

const GUEST = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]*)[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s+(.*)$/gi;

/**
 * A title's parts: the name itself, its notes (a bracketed subtitle or version, or what
 * follows a dash, as in "Song - Live at Wembley") and the guests it credits.
 */
export function titleParts(name: string) {
  const guests: string[] = [], notes: string[] = [];
  let base = name.replace(GUEST, (_, bracketed: string | undefined, trailing: string | undefined) => {
    guests.push(bracketed ?? trailing ?? "");
    return "";
  });
  base = base.replace(/\s*[([]([^)\]]*)[)\]]/g, (_, note: string) => { notes.push(note); return " "; });
  base = base.replace(/\s+[-–—]\s+(.*)$/, (_, note: string) => { notes.push(note); return ""; });
  // "(Untitled)" is all brackets; its name is what they hold.
  if (!fold(base)) return { base: name, notes: [], guests };
  return { base, notes, guests };
}

/** One act's name, and each act when a credit names several ("Pete Rock & C.L. Smooth"). */
export function artistCredits(names: string[]) {
  const credits = new Set<string>();
  for (const name of names) {
    const plain = name.replace(/\s*[([][^)\]]*[)\]]/g, "");
    const whole = fold(plain);
    if (whole) credits.add(whole);
    for (const part of plain.split(/\s*(?:,|&|\+|\band\b|\bx\b|\bvs\.?(?=\s)|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i)) {
      const folded = fold(part);
      if (folded) credits.add(folded);
    }
  }
  return credits;
}

export type Entry = {
  title: string;
  /** Version notes kept apart from the title, such as a service's own "version" field. */
  notes?: string[];
  artists: string[];
  album?: string;
};

type Fields = { title: string[]; notes: string[]; artists: string[][]; album: string[] };

function fields(entry: Entry): Fields {
  const parts = titleParts(entry.title);
  return {
    title: foldTokens(parts.base),
    notes: foldTokens([...parts.notes, ...entry.notes ?? []].join(" ")),
    artists: [...artistCredits([...entry.artists, ...parts.guests])].map(name => name.split(" ")),
    album: foldTokens(entry.album ?? ""),
  };
}

export type Match = {
  /** 0 to 1: how well the entry answers the query. */
  score: number;
  /** How much of the query the entry explains. */
  coverage: number;
  /** How much of the entry's title the query names. */
  title: number;
  /** How much of its best-matching artist's name the query names. */
  artist: number;
};

const NONE: Match = { score: 0, coverage: 0, title: 0, artist: 0 };

/**
 * Each typed word is explained by the field that explains it best, and counts for more the
 * more of that field the query names: "hey ya" is all of the song "Hey Ya!" but a third of
 * "Ya No Resisto" by Hey. Words the entry doesn't explain count against it twice over, so a
 * song with the right title by another artist stays well behind the one asked for.
 */
function matchFields(query: Query, entry: Fields): Match {
  if (!query.words.length) return NONE;
  const title = matchWords(query.words, entry.title);
  const notes = matchWords(query.words, entry.notes);
  const album = matchWords(query.words, entry.album);
  const named = share(entry.title, title.used);
  const found = query.words.map((_, i) => Math.max(title.found[i], notes.found[i], album.found[i] * 0.5));
  const explained = query.words.map((_, i) => Math.max(title.found[i] * (0.6 + 0.4 * named), notes.found[i] * 0.8, album.found[i] * 0.4));
  let artist = 0;
  for (const name of entry.artists) {
    const credit = matchWords(query.words, name);
    const whole = share(name, credit.used);
    artist = Math.max(artist, whole);
    for (let i = 0; i < found.length; i++) {
      found[i] = Math.max(found[i], credit.found[i]);
      explained[i] = Math.max(explained[i], credit.found[i] * (0.55 + 0.4 * whole));
    }
  }
  const coverage = share(query.words, found);
  // "Ya Hey" is not "Hey Ya": title words asked for out of order are a weaker answer.
  const places = title.at.filter(place => place >= 0);
  const ordered = places.every((place, index) => index === 0 || place >= places[index - 1]);
  return { score: share(query.words, explained) * coverage * (ordered ? 1 : 0.93), coverage, title: named, artist };
}

export function matchEntry(entry: Entry, query: string): Match {
  return matchFields(parse(query), fields(entry));
}

const trackFields = new WeakMap<Track, Fields>();

export function matchTrack(track: Track, query: string): Match {
  let entry = trackFields.get(track);
  if (!entry) {
    entry = fields({
      title: track.name,
      notes: track.version ? [track.version] : [],
      artists: track.artists.length ? track.artists.map(artist => artist.name) : [track.artist],
      album: `${track.album} ${track.albumVersion ?? ""}`,
    });
    trackFields.set(track, entry);
  }
  return matchFields(parse(query), entry);
}

/**
 * How much of `name` the query spells out, and how much of the query that name is. `exact`
 * when every word of the name the query matched is spelled as typed, not a near miss or a
 * word still being typed.
 */
export function matchName(name: string, query: string) {
  const typed = parse(query);
  const words = foldTokens(name);
  const result = matchWords(typed.words, words);
  return { named: share(words, result.used), coverage: share(typed.words, result.found),
    exact: result.found.some(score => score > 0) && result.found.every(score => score === 0 || score >= 0.95) };
}

// Someone else's rendition, or the song altered: never what a plain search for the song means.
const REMAKE = /\b(karaoke|tribute|lullab\w*|nightcore|sped up|slowed|8d|8 bit|music box|made famous|originally performed|in the style of|for babies|4 babies|for kids)\b/g;
const COVER = /\b(cover|covers|covered)\b/g;
// The artist's own alternate takes.
const TAKE = /\b(instrumental|acapella|capella|cappella|remix|rmx|mix|live|demo|acoustic|session|sessions|dub|rework|bootleg|extended|reprise|skit|commentary|take|outtake|alternate|rehearsal)\b/g;
const EDIT = /\b(edit)\b/g;

/**
 * 1 for the song as released; less for an alternate take (remix, live, instrumental) and much
 * less for a remake (karaoke, tribute, lullaby), unless the query asks for that kind by name.
 */
export function variantFactor(entry: Entry, query: string) {
  const asked = new Set(parse(query).words);
  const unasked = (text: string, pattern: RegExp) =>
    (text.match(pattern) ?? []).some(marker => !marker.split(" ").every(word => asked.has(word)));
  const parts = titleParts(entry.title);
  const notes = fold([...parts.notes, ...entry.notes ?? []].join(" ")).replace(/\boriginal mix\b/g, " ");
  const context = `${notes} ${fold(entry.artists.join(" "))} ${fold(entry.album ?? "")}`;
  if (unasked(context, REMAKE) || unasked(`${notes} ${fold(entry.album ?? "")}`, COVER)) return 0.55;
  if (unasked(notes, TAKE)) return 0.85;
  if (unasked(notes, EDIT)) return 0.95;
  return 1;
}

/**
 * Other ways to ask a service for the same thing, for when it finds nothing good under the
 * query as typed: without separators and brackets, without bracketed notes, then the title
 * alone from "Artist – Title". At most three, none equal to the query.
 */
export function queryVariants(query: string) {
  const tidy = (value: string) => value.replace(/[–—|]+|\s-\s/g, " ").replace(/[()[\]{}"“”]/g, " ")
    .split(/\s+/).filter(word => !NOISE.has(word.toLowerCase())).join(" ").trim();
  const unbracketed = query.replace(/[([{][^)\]}]*[)\]}]/g, " ");
  const parts = query.split(/\s+[-–—|]\s+/);
  const variants = [tidy(query), tidy(unbracketed), parts.length > 1 ? tidy(parts.slice(1).join(" ")) : ""];
  const seen = new Set([query.toLowerCase().trim()]);
  return variants.filter(variant => {
    const key = variant.toLowerCase();
    if (!variant || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
