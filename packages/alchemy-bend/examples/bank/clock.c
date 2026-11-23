// Clock.unix: seconds since 1970, from the host's wall clock.
#include <time.h>

Term clock_unix_run(Env e, Term* f, IoWork* w) {
  return (Term)(u32)time(NULL);
}

static void __attribute__((constructor)) clock_unix_use(void) {
  io_eff(CID(Clock.unix), clock_unix_run);
}
