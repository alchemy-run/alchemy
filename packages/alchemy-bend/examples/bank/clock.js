// Clock.unix: seconds since 1970, from the host's wall clock.
function clock_unix() {
  return Math.floor(Date.now() / 1000) >>> 0;
}

io_eff(CID(Clock.unix), clock_unix);
