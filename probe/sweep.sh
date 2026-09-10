#!/usr/bin/env bash
# Run the full 3-call cache probe against each candidate model.
# The model we build on is whichever one shows a cached_tokens value that MOVES.
set -u
NODE="$HOME/.local/share/mise/installs/node/22.23.2/bin/node"
CANDIDATES="${1:-glm-4.7-flash,glm-4.5-flash,glm-5.3-flash}"
mkdir -p out
echo "### model enumeration"
"$NODE" --env-file=.env probe/models.ts 2>&1 | tee out/models.txt
IFS=',' read -ra MODELS <<< "$CANDIDATES"
for m in "${MODELS[@]}"; do
  echo; echo "################ candidate: $m"
  "$NODE" --env-file=.env probe/step_zero.ts "$m" 2>&1 | tee "out/step_zero.$m.txt"
  echo "   exit=$? for $m"
done
echo; echo "### verdict lines across candidates"
grep -H -E 'VERDICT|cached_tokens (field present|rose|dropped)' out/step_zero.*.txt || true
