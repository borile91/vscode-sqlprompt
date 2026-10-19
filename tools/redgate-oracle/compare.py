"""Confronta due cartelle di .sql (atteso vs motore): conteggi e primi blocchi di differenza.
Uso: python3 -I compare.py <atteso> <ottenuto> [--hunks N] [--list]"""
import difflib
import os
import sys


def norm(path):
    with open(path, 'rb') as f:
        data = f.read()
    for bom in (b'\xef\xbb\xbf',):
        if data.startswith(bom):
            data = data[len(bom):]
    if data.startswith(b'\xff\xfe') or data.startswith(b'\xfe\xff'):
        text = data.decode('utf-16')
    else:
        text = data.decode('utf-8', errors='replace')
    return text.replace('\r\n', '\n').rstrip('\n').split('\n')


def main():
    exp_dir, got_dir = sys.argv[1], sys.argv[2]
    hunks = int(sys.argv[sys.argv.index('--hunks') + 1]) if '--hunks' in sys.argv else 0
    files = sorted(f for f in os.listdir(exp_dir) if f.endswith('.sql'))
    same = 0
    total_lines = 0
    diff_lines = 0
    failing = []
    for f in files:
        g = os.path.join(got_dir, f)
        if not os.path.exists(g):
            failing.append((f, -1))
            continue
        e, a = norm(os.path.join(exp_dir, f)), norm(g)
        total_lines += len(e)
        if e == a:
            same += 1
            continue
        sm = difflib.SequenceMatcher(None, e, a, autojunk=False)
        d = sum(i2 - i1 for tag, i1, i2, _, _ in sm.get_opcodes() if tag != 'equal')
        diff_lines += d
        failing.append((f, d))
    print(f'identici: {same}/{len(files)}  righe diverse: {diff_lines}/{total_lines} '
          f'({100.0 * (total_lines - diff_lines) / max(1, total_lines):.1f}% uguali)')
    if '--list' in sys.argv:
        for f, d in sorted(failing, key=lambda x: x[1]):
            print(f'  {d:5d} {f}')
    shown = 0
    for f, d in sorted(failing, key=lambda x: x[1]):
        if shown >= hunks:
            break
        if d < 0:
            continue
        e, a = norm(os.path.join(exp_dir, f)), norm(os.path.join(got_dir, f))
        print(f'=== {f} ({d})')
        for line in list(difflib.unified_diff(e, a, 'atteso', 'motore', n=1, lineterm=''))[2:40]:
            print(line[:200])
        shown += 1


main()
