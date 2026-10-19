#!/usr/bin/env bash
# Casi "una opzione per volta" (formatter-engine/tests/options): genera input e stili dallo schema
# dell'editor, poi chiede alla CLI di SQL Prompt l'output atteso di ogni caso (expected/<caso>.sql).
# Uso: tools/redgate-oracle/build-options.sh [sezione...]   (dalla root del repo, client compilato)
#   con delle sezioni rigenera solo i loro casi; gli altri attesi restano
# Variabili d'ambiente: come redgate-format.sh (ORACLE_VM, ORACLE_HOST_ROOT, ORACLE_UNC_ROOT, ORACLE_CLI)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$root/formatter-engine/tests/options"
node "$root/tools/redgate-oracle/options-cases.mjs" "$dir"

VM="${ORACLE_VM:-Windows 11}"
HOST_ROOT="${ORACLE_HOST_ROOT:-$HOME/Development/_sqlprompt-re/oracle}"
UNC_ROOT="${ORACLE_UNC_ROOT:-\\\\Mac\\Development\\_sqlprompt-re\\oracle}"
CLI="${ORACLE_CLI:-C:\\Program Files (x86)\\Red Gate\\SQL Prompt 11\\SqlPrompt.Format.CommandLine.exe}"

if prlctl list -a | grep -q "suspended .*$VM\|paused .*$VM"; then
  prlctl resume "$VM" >/dev/null
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  prlctl exec "$VM" cmd /c "echo ok" 2>/dev/null | grep -q ok && break
  sleep 3
done

run="opt-$$-$(date +%s)"
stage="$HOST_ROOT/$run"
mkdir -p "$stage"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$dir/expected"
# attesi di casi che non esistono più
for f in "$dir"/expected/*.sql; do
  [[ -f "$f" ]] || continue
  grep -q "^$(basename "$f" .sql) " "$dir/cases.txt" || rm "$f"
done

cases=()
while read -r name section _; do
  [[ -n "$name" ]] || continue
  if [[ $# -gt 0 ]] && [[ " $* " != *" $section "* ]]; then continue; fi
  cases+=("$name $section")
done < "$dir/cases.txt"
# Più casi per sessione prlctl (ognuno con il proprio stile), ma non troppi: le sessioni lunghe cadono
chunk="${ORACLE_CHUNK:-40}"

# Formatta i casi di "todo" (righe "caso sezione"); quelli rimasti identici all'input
# (sessione caduta a metà) finiscono in "retry"
run_cases() {
  retry=()
  local start i part cmd name section
  for ((start = 0; start < ${#todo[@]}; start += chunk)); do
    part="p$((start / chunk))-$round"
    cmd="$stage/$part.cmd"
    printf '@echo off\r\n' > "$cmd"
    for ((i = start; i < start + chunk && i < ${#todo[@]}; i++)); do
      read -r name section <<< "${todo[i]}"
      mkdir -p "$stage/$part/c$i"
      cp "$dir/inputs/$section.sql" "$stage/$part/c$i/"
      cp "$dir/styles/$name.json" "$stage/$part/c$i.json"
      printf '"%s" --i-agree-to-the-eula --apply-casing -p "%s\\%s\\%s\\c%d" -s "%s\\%s\\%s\\c%d.json" >> "%s\\%s\\%s.log" 2>&1\r\n' \
        "$CLI" "$UNC_ROOT" "$run" "$part" "$i" "$UNC_ROOT" "$run" "$part" "$i" "$UNC_ROOT" "$run" "$part" >> "$cmd"
    done
    printf 'echo done > "%s\\%s\\%s.exit"\r\n' "$UNC_ROOT" "$run" "$part" >> "$cmd"

    for attempt in 1 2 3; do
      rm -f "$stage/$part.exit" "$stage/$part.log"
      prlctl exec "$VM" cmd /c "$UNC_ROOT\\$run\\$part.cmd" >/dev/null 2>&1 || true
      [[ -f "$stage/$part.exit" ]] && break
      prlctl resume "$VM" >/dev/null 2>&1 || true
      sleep 5
    done
    [[ -f "$stage/$part.exit" ]] || { echo "blocco $part fallito dopo 3 tentativi" >&2; exit 1; }
    if grep -q "Error encountered" "$stage/$part.log"; then cat "$stage/$part.log" >&2; exit 1; fi

    for ((i = start; i < start + chunk && i < ${#todo[@]}; i++)); do
      read -r name section <<< "${todo[i]}"
      out="$stage/$part/c$i/$section.sql"
      if cmp -s "$out" "$dir/inputs/$section.sql"; then retry+=("${todo[i]}"); continue; fi
      cp "$out" "$dir/expected/$name.sql"
    done
    echo "$part: casi $start..$((i - 1))"
  done
}

todo=("${cases[@]}")
for round in 1 2 3; do
  run_cases
  [[ ${#retry[@]} -eq 0 ]] && break
  echo "da rifare: ${#retry[@]}"
  todo=("${retry[@]}")
done
# la CLI lascia invariato solo un input che non riesce ad analizzare: l'esempio va corretto
for c in "${retry[@]+"${retry[@]}"}"; do
  read -r name section <<< "$c"
  echo "INVARIATO (input non analizzabile?): $name" >&2
  cp "$dir/inputs/$section.sql" "$dir/expected/$name.sql"
done
echo "attesi: $(ls "$dir/expected" | wc -l | tr -d ' ')"
