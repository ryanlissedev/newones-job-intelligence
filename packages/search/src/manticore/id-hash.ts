// Manticore's document id (the top-level "id" on /replace and /delete) must
// be an integer — SearchDocument.id is a string (a Postgres UUID in
// production, "bench-doc-N" in the benchmark corpus). This hashes the
// string id into a stable, effectively-collision-free integer under
// Number.MAX_SAFE_INTEGER (2^53), so JSON serialization never loses
// precision and no BigInt is needed (apps/web's tsconfig targets ES2018,
// which rejects BigInt literal syntax, and this repo's lint autofixer
// always rewrites BigInt(...) calls back into literals).
//
// cyrb53 — public-domain 53-bit string hash by bryc
// (https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js),
// built entirely from Math.imul and 32-bit bitwise ops (no BigInt).
// Collision probability over n ids is roughly n^2 / 2^54 (birthday bound) —
// about 3e-6 at n=240,000. A collision silently overwrites one document with
// another in Manticore; accepted at Slice A scale, revisit if the corpus
// grows an order of magnitude or more.
/* oxlint-disable no-bitwise -- cyrb53 is defined in terms of XOR, shifts, and imul */
export const hashDocumentId = (id: string, seed = 0): number => {
  let h1 = 0xde_ad_be_ef ^ seed;
  let h2 = 0x41_c6_ce_57 ^ seed;
  for (let index = 0; index < id.length; index += 1) {
    const ch = id.codePointAt(index) ?? 0;
    h1 = Math.imul(h1 ^ ch, 2_654_435_761);
    h2 = Math.imul(h2 ^ ch, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return 4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0);
};
/* oxlint-enable no-bitwise */
