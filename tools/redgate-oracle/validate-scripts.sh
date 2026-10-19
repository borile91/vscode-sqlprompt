#!/usr/bin/env bash
# Valida il motore .NET su una cartella di script reali usando la CLI Redgate come oracolo.
# Gli script e i risultati restano nella cartella di lavoro, FUORI dal repository.
# Uso: tools/redgate-oracle/validate-scripts.sh <stile.json> <cartella-script> <cartella-lavoro> [--oracle]
#   --oracle   (ri)genera l'output Redgate; senza, riusa quello già presente nella cartella di lavoro
# Poi: python3 -I tools/redgate-oracle/cluster.py <lavoro>/redgate <lavoro>/engine  (differenze per tipo)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
style="$1"; src="$2"; work="$3"; oracle="${4:-}"
mkdir -p "$work/in" "$work/redgate"

# copia piatta: percorso relativo con __ al posto di / e _ al posto degli spazi
if [[ -z "$(ls -A "$work/in")" ]]; then
  (cd "$src" && find . -name '*.sql' | while read -r f; do
    rel=${f#./}
    cp "$f" "$work/in/$(echo "$rel" | sed 's|/|__|g; s| |_|g')"
  done)
fi

if [[ "$oracle" == "--oracle" ]]; then
  "$root/tools/redgate-oracle/redgate-format.sh" -c -s "$style" -o "$work/redgate" "$work"/in/*.sql
fi

dotnet build "$root/formatter-engine/src/SqlFormatter.Sidecar" -c Debug --nologo -v q >/dev/null
rm -rf "$work/engine"
dotnet "$root/formatter-engine/src/SqlFormatter.Sidecar/bin/Debug/net10.0/SqlFormatter.Sidecar.dll" \
  format-dir "$style" "$work/in" "$work/engine" 2> "$work/engine.err"
python3 -I "$root/tools/redgate-oracle/compare.py" "$work/redgate" "$work/engine"
