#!/usr/bin/env bash
# Rigenera il corpus di test del motore .NET usando la CLI Redgate come oracolo.
# Ogni input del corpus viene formattato con ogni stile: expected/<stile>/<input>.sql
# Uso: tools/redgate-oracle/build-corpus.sh   (dalla root del repo)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
corpus="$root/formatter-engine/tests/corpus"
examples="$root/client/src/formatter/__tests__/examples"
oracle="$root/tools/redgate-oracle/redgate-format.sh"

mkdir -p "$corpus/inputs" "$corpus/styles"

# Input: le fixture esistenti (già output Redgate del loro profilo) e gli esempi non ancora passanti
for p in "$examples"/*/; do
  name=$(basename "$p")
  cp "$p/config.json" "$corpus/styles/$name.json"
  for f in "$p"*.sql; do cp "$f" "$corpus/inputs/${name}__$(basename "$f")"; done
done
for f in "$root"/docs/formatting/example-not-passing/examples/*/*.sql; do
  [[ -f "$f" ]] || continue
  cp "$f" "$corpus/inputs/notpassing_$(basename "$(dirname "$f")")__$(basename "$f")"
done
# Casi mock anonimizzati (formatter-engine/tests/corpus/mocks): ricavati dalle combinazioni
# trovate negli script reali, con nomi inventati
for f in "$corpus"/mocks/*.sql; do
  [[ -f "$f" ]] || continue
  cp "$f" "$corpus/inputs/$(basename "$f")"
done

# Stili incorporati in SQL Prompt (estratti da SQLPrompt.Format.exe): già in corpus/styles/embedded_*.json

for s in "$corpus"/styles/*.json; do
  style=$(basename "$s" .json)
  rm -rf "$corpus/expected/$style"
  "$oracle" -c -s "$s" -o "$corpus/expected/$style" "$corpus"/inputs/*.sql
  echo "$style: $(ls "$corpus/expected/$style" | wc -l | tr -d ' ') file"
done
