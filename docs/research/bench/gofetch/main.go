package main
import ("fmt";"io";"net/http";"sync";"sync/atomic";"syscall";"time")
func main() { const TOTAL, C = 2000, 50; var n int64; var wg sync.WaitGroup; t0 := time.Now()
  for i := 0; i < C; i++ { wg.Add(1); go func() { defer wg.Done(); for atomic.AddInt64(&n, 1) <= TOTAL { r, _ := http.Get("http://127.0.0.1:4567/"); io.Copy(io.Discard, r.Body); r.Body.Close() } }() }
  wg.Wait(); var ru syscall.Rusage; syscall.Getrusage(0, &ru)
  fmt.Printf("go fetch: %d reqs c=%d in %dms maxRSS=%dMB\n", TOTAL, C, time.Since(t0).Milliseconds(), ru.Maxrss/1e6) }
