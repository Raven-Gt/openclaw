#!/usr/bin/env bash
# Proof-only: run one native test filter repeatedly under CPU load and record outcomes.
set -uo pipefail
phase="$1"; filter="$2"; iterations="$3"
out="$RUNNER_TEMP/nativeauth-proof"
mkdir -p "$out/logs"
cpus="$(sysctl -n hw.logicalcpu)"
load=$(( cpus > 1 ? cpus - 1 : 1 ))
width=$(( cpus < 12 ? cpus : 12 ))
pids=()
for _ in $(seq 1 "$load"); do yes > /dev/null & pids+=($!); done
echo "[$phase] cpus=$cpus yes-load=$load filter=$filter iterations=$iterations" | tee -a "$out/summary.txt"
pass=0; fail=0; nomatch=0
for i in $(seq 1 "$iterations"); do
  log="$out/logs/$phase-$i.log"
  start=$(date +%s)
  node scripts/test-macos-native.mts default \
    --package-path apps/macos --build-system native --enable-code-coverage \
    --disable-index-store -Xswiftc -gline-tables-only --skip-build \
    --experimental-maximum-parallelization-width "$width" \
    --filter "$filter" >"$log" 2>&1
  code=$?
  secs=$(( $(date +%s) - start ))
  if grep -q "Test run with 0 tests" "$log"; then
    nomatch=$((nomatch + 1)); verdict=NOMATCH
  elif [ "$code" -eq 0 ]; then
    pass=$((pass + 1)); verdict=PASS
  else
    fail=$((fail + 1)); verdict=FAIL
  fi
  tests=$(grep -Eo "Test run with [0-9]+ tests" "$log" | tail -1)
  echo "[$phase] #$i $verdict exit=$code wall=${secs}s ($tests)" | tee -a "$out/summary.txt"
  if [ "$verdict" != PASS ]; then
    grep -E "✘ Test .*(recorded an issue|failed after)|↳ Native auth reply|error:" "$log" | head -8 | sed 's/^/    /' | tee -a "$out/summary.txt"
  fi
  grep -E "✔ Test \"saved profile reconnect.*passed after" "$log" | head -1 | sed 's/^/    /' | tee -a "$out/summary.txt"
done
kill "${pids[@]}" 2>/dev/null
wait 2>/dev/null
echo "[$phase] RESULT pass=$pass fail=$fail nomatch=$nomatch of $iterations" | tee -a "$out/summary.txt"
exit 0
