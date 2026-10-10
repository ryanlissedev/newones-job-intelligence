package main
import ("fmt";"os";"strconv";"strings";"time";"runtime")
var s uint32 = 12345
func rnd() uint32 { s = s*1664525 + 1013904223; return s }
func fnv(b string) uint32 { h := uint32(0x811c9dc5); for i := 0; i < len(b); i++ { h ^= uint32(b[i]); h *= 0x01000193 }; return h }
func fmix(h uint32) uint32 { h ^= h >> 16; h *= 0x85ebca6b; h ^= h >> 13; h *= 0xc2b2ae35; h ^= h >> 16; return h }
func main() {
  n, _ := strconv.Atoi(os.Args[1]); const P = 128
  var seeds [P]uint32; for i := range seeds { seeds[i] = rnd() }
  docs := make([]string, n)
  for i := range docs { w := make([]string, 300); for j := range w { w[j] = "w" + strconv.Itoa(int(rnd()%5000)) }; docs[i] = strings.Join(w, " ") }
  t0 := time.Now(); var acc uint32
  for _, d := range docs { w := strings.Split(d, " "); var sig [P]uint32; for p := range sig { sig[p] = 0xffffffff }
    for i := 0; i+2 < len(w); i++ { h := fnv(w[i] + " " + w[i+1] + " " + w[i+2])
      for p := 0; p < P; p++ { v := fmix(h ^ seeds[p]); if v < sig[p] { sig[p] = v } } }
    acc ^= sig[0] }
  ms := float64(time.Since(t0).Microseconds()) / 1000; var m runtime.MemStats; runtime.ReadMemStats(&m)
  fmt.Printf("go minhash: %d docs in %.0f ms (%.0f docs/s) chk=%d rss~%dMB\n", n, ms, float64(n)/ms*1000, acc, m.Sys/1e6)
}
