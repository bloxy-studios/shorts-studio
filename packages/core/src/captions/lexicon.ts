/**
 * Function words never receive emphasis styling. English plus common Kiswahili
 * function words so mixed English/Kiswahili speech is handled without translation.
 */
const EN = `a an the and or but nor so yet for of to in on at by from with without into onto over under about as than then
that this these those there here it its it's is are was were be been being am do does did done have has had having
i me my mine we us our you your he him his she her they them their what which who whom whose when where why how
if because while though although until unless since just only also too very really quite not no yes okay ok oh uh um
like well gonna wanna can could would should will shall may might must let let's i'm you're we're they're that's
there's it'll i'll you'll we'll i've you've we've don't doesn't didn't can't won't isn't aren't wasn't weren't
up down out off again more most some any all each every both either neither such own same other another`;

const SW = `na ya wa kwa ni la za cha vya katika hii huu hiyo huo hizo hilo lakini kama au pia sana tu ndio hapana
mimi wewe yeye sisi nyinyi wao yangu yako yake yetu yenu yao hapa pale huko kule sasa bado basi halafu kisha
ambaye ambao ambayo ambalo ambacho ile yule wale kwamba kuwa kuna iko yuko wako tuko mko ndiyo hivyo hivi`;

export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  `${EN} ${SW}`
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
);

/** Lowercased word with surrounding punctuation stripped (keeps inner apostrophes). */
export function normalizeToken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function isFunctionWord(text: string): boolean {
  const t = normalizeToken(text);
  return t.length === 0 || FUNCTION_WORDS.has(t);
}

export function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]*$/.test(text.trim());
}

export function endsClause(text: string): boolean {
  return /[,;:—-]["')\]]*$/.test(text.trim());
}

/** Filler / disfluency tokens that are candidates for removal in creator edits. */
export const FILLERS: ReadonlySet<string> = new Set(["um", "uh", "erm", "er", "ah", "hmm", "mm", "eh", "ehh", "umm", "uhh"]);
