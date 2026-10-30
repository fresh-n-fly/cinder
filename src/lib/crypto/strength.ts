/**
 * A rough, conservative estimate of how many guesses (in bits) a password
 * costs an attacker who tries common words, simple substitutions, years,
 * keyboard runs, and repeated or sequential characters first.
 *
 * It only has to reject the passwords people actually pick ("Password123!",
 * "Summer2026!!") while accepting random strings and phrases of unrelated
 * words. It runs in the browser on every keystroke, so it stays small.
 */

/** Bits charged for a word an attacker's dictionary would contain. */
const WORD_BITS = 11;

// Common password roots, names, places, and words. Matched after lowercasing
// and undoing simple substitutions (0→o, 3→e, @→a, …).
const WORDS = new Set(
  `password passwd pass word secret letmein welcome admin administrator root login access account default
  changeme guest user test testing sample example master super superuser hello world helloworld
  qwerty qwertyuiop qwertz azerty asdf asdfgh asdfghjkl zxcv zxcvbn zxcvbnm qazwsx wsxedc abcd abcdef abcdefg
  iloveyou love lover lovely loveme baby babygirl angel heaven princess prince queen king lady sweet honey
  monkey dragon tiger lion bear wolf eagle shark horse puppy kitty kitten pony bunny
  master shadow sunshine sunflower flower garden forest ocean river mountain sunset sunrise rainbow butterfly
  football baseball soccer hockey basketball tennis golf rugby cricket chelsea arsenal liverpool barcelona madrid
  superman batman spiderman starwars pokemon matrix ninja pirate wizard magic legend hero warrior soldier
  michael jennifer jordan hunter ranger buster tigger charlie robert thomas daniel andrew joshua matthew jessica
  ashley amanda nicole hannah taylor jackson william james david richard joseph sarah emily olivia sophia
  maggie bailey buddy lucky molly bella daisy rocky oliver jack harley ginger
  summer winter spring autumn january february march april june july august september october november december
  monday tuesday wednesday thursday friday saturday sunday morning evening night today tomorrow
  computer internet google apple samsung microsoft windows linux iphone android laptop
  chocolate cookie cheese pepper banana orange purple yellow silver golden diamond crystal
  family friend friends happy smile money cash bank finance payroll invoice report reports document
  company office work school student teacher college university business manager
  freedom whatever nothing something everything forever always never trust justice liberty
  america canada england london paris berlin newyork texas florida california
  correct battery staple horse troubador cinder files file secure security private privacy safe hidden
  community vault locked unlock open sesame opensesame killer hacker`
    .split(/\s+/)
    .filter((word) => word.length >= 4),
);
const LONGEST_WORD = Math.max(...[...WORDS].map((word) => word.length));

const SUBSTITUTIONS: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
  "+": "t",
};

type CharClass = "letter" | "digit" | "separator" | "symbol";

function classOf(char: string): CharClass {
  if (/\p{L}/u.test(char)) return "letter";
  if (/\p{Nd}/u.test(char)) return "digit";
  if (/[\s\-_.]/.test(char)) return "separator";
  return "symbol";
}

/** lower, Capitalized, or UPPER: how people write words. Anything else is mixed at random. */
function looksLikeWord(run: string[]): boolean {
  const text = run.join("");
  return text === text.toLowerCase() || text === text.toUpperCase() || /^\p{Lu}\p{Ll}+$/u.test(text);
}

function baseBits(kind: CharClass, wordShaped: boolean): number {
  switch (kind) {
    // Letters inside a word-shaped run of three or more are probably a word.
    case "letter":
      return wordShaped ? 3.5 : 4.7;
    case "digit":
      return 3.32;
    case "separator":
      return 2.5;
    default:
      return 5;
  }
}

function runBits(run: string[], kind: CharClass): number {
  if (kind === "digit" && run.length === 4 && /^(19|20)\d\d$/.test(run.join(""))) return 7;
  const wordShaped = kind === "letter" && run.length >= 3 && looksLikeWord(run);
  let bits = 0;
  for (let index = 0; index < run.length; index += 1) {
    const char = run[index]!;
    const previous = index > 0 ? run[index - 1]! : null;
    if (previous !== null) {
      const step = Math.abs(char.codePointAt(0)! - previous.codePointAt(0)!);
      // Repeats ("aaaa", "!!!") and runs ("abcd", "1234", "9876") add little.
      if (step <= 1) {
        bits += 1;
        continue;
      }
    }
    bits += baseBits(kind, wordShaped);
  }
  return bits;
}

/** Longer input is strong whatever it holds; capping keeps each keystroke cheap. */
const MAX_SCORED_CHARS = 256;

export function estimatePasswordBits(password: string): number {
  const chars = [...password].slice(0, MAX_SCORED_CHARS);
  if (chars.length === 0) return 0;
  const plain = chars.map((char) => {
    const lower = char.toLowerCase();
    return SUBSTITUTIONS[lower] ?? lower;
  });
  const covered = new Array<boolean>(chars.length).fill(false);
  let bits = 0;

  // Dictionary words, longest match first, scanning left to right.
  for (let start = 0; start < chars.length; ) {
    let matched = 0;
    for (let length = Math.min(LONGEST_WORD, chars.length - start); length >= 4; length -= 1) {
      if (WORDS.has(plain.slice(start, start + length).join(""))) {
        matched = length;
        break;
      }
    }
    if (matched === 0) {
      start += 1;
      continue;
    }
    const original = chars.slice(start, start + matched);
    bits += WORD_BITS;
    if (original.some((char) => char !== char.toLowerCase())) bits += 1;
    if (original.some((char, index) => char.toLowerCase() !== plain[start + index])) bits += 1;
    covered.fill(true, start, start + matched);
    start += matched;
  }

  // Everything else, as runs of one character class.
  let run: string[] = [];
  let kind: CharClass | null = null;
  const flush = () => {
    if (run.length > 0 && kind) bits += runBits(run, kind);
    run = [];
    kind = null;
  };
  for (let index = 0; index < chars.length; index += 1) {
    if (covered[index]) {
      flush();
      continue;
    }
    const char = chars[index]!;
    const next = classOf(char);
    if (kind !== next) flush();
    kind = next;
    run.push(char);
  }
  flush();
  return bits;
}
