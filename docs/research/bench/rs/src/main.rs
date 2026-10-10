use std::time::Instant;
static mut S: u32 = 12345;
fn rnd() -> u32 { unsafe { S = S.wrapping_mul(1664525).wrapping_add(1013904223); S } }
fn fnv(b: &[u8]) -> u32 { let mut h: u32 = 0x811c9dc5; for &c in b { h ^= c as u32; h = h.wrapping_mul(0x01000193); } h }
#[inline(always)] fn fmix(mut h: u32) -> u32 { h ^= h >> 16; h = h.wrapping_mul(0x85ebca6b); h ^= h >> 13; h = h.wrapping_mul(0xc2b2ae35); h ^= h >> 16; h }
fn main() {
  let n: usize = std::env::args().nth(1).unwrap().parse().unwrap(); const P: usize = 128;
  let seeds: Vec<u32> = (0..P).map(|_| rnd()).collect();
  let docs: Vec<String> = (0..n).map(|_| (0..300).map(|_| format!("w{}", rnd() % 5000)).collect::<Vec<_>>().join(" ")).collect();
  let t0 = Instant::now(); let mut acc = 0u32;
  for d in &docs { let w: Vec<&str> = d.split(' ').collect(); let mut sig = [u32::MAX; P];
    for i in 0..w.len().saturating_sub(2) { let sh = format!("{} {} {}", w[i], w[i+1], w[i+2]); let h = fnv(sh.as_bytes());
      for p in 0..P { let v = fmix(h ^ seeds[p]); if v < sig[p] { sig[p] = v; } } }
    acc ^= sig[0]; }
  let ms = t0.elapsed().as_secs_f64() * 1000.0;
  println!("rust minhash: {} docs in {:.0} ms ({:.0} docs/s) chk={}", n, ms, n as f64 / ms * 1000.0, acc);
}
