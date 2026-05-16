#!/usr/bin/env bash
set -euo pipefail

# Convenience entrypoint. The Node runner is the primary interface:
#
#   node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js ...
#
# Smoke:
#
# BENCH_ID="cold-concurrent-uma-smoke-$(date +%Y%m%d-%H%M%S)"
# bash scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.sh \
#   --benchmark-id "$BENCH_ID" \
#   --concurrency-levels 1 \
#   --bursts 1 \
#   --force \
#   --keep-services-running
#
# Final:
#
# BENCH_ID="cold-concurrent-uma-final-$(date +%Y%m%d-%H%M%S)"
# bash scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.sh \
#   --benchmark-id "$BENCH_ID" \
#   --concurrency-levels 1,2,5,10,20 \
#   --bursts 30 \
#   --force

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"
exec node scripts/benchmark/run_concurrent_cold_uma_authorization_with_services.js "$@"
