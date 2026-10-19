"""Raggruppa le differenze per tipo: per ogni hunk produce una firma e conta le firme.
Uso: python3 -I cluster.py <atteso> <ottenuto> [max_esempi]"""
import collections
import difflib
import os
import re
import sys


def norm(p):
    d = open(p, 'rb').read()
    if d.startswith(b'\xef\xbb\xbf'):
        d = d[3:]
    return d.decode('utf-8', 'replace').replace('\r\n', '\n').rstrip('\n').split('\n')


def words(line):
    return re.sub(r'\s+', ' ', line.strip())


def first_word(line):
    w = line.strip().split(' ')[0]
    return re.sub(r'[^A-Za-z(),;=*@-]', '', w)[:12] or '·'


def signature(e_lines, a_lines):
    ej, aj = ' '.join(words(x) for x in e_lines), ' '.join(words(x) for x in a_lines)
    if all(not x.strip() for x in e_lines + a_lines):
        return 'righe-vuote'
    if re.sub(r'\s', '', ej) == re.sub(r'\s', '', aj):
        if len(e_lines) == len(a_lines):
            if [words(x) for x in e_lines] == [words(x) for x in a_lines]:
                return f'rientro:{first_word(e_lines[0])}'
            return f'spazi:{first_word(e_lines[0])}'
        return f'a-capo({len(e_lines)}->{len(a_lines)}):{first_word(e_lines[0]) if e_lines else first_word(a_lines[0])}'
    if ej.lower() == aj.lower():
        return 'maiuscole'
    return f'testo:{first_word(e_lines[0]) if e_lines else "·"}'


def main():
    exp, got = sys.argv[1], sys.argv[2]
    nex = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    sigs = collections.Counter()
    files = collections.defaultdict(set)
    examples = collections.defaultdict(list)
    for f in sorted(os.listdir(exp)):
        g = os.path.join(got, f)
        if not f.endswith('.sql') or not os.path.exists(g):
            continue
        e, a = norm(os.path.join(exp, f)), norm(g)
        if e == a:
            continue
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, e, a, autojunk=False).get_opcodes():
            if tag == 'equal':
                continue
            s = signature(e[i1:i2], a[j1:j2])
            sigs[s] += 1
            files[s].add(f)
            if len(examples[s]) < nex:
                examples[s].append((f, e[max(0, i1 - 1):i2 + 1], a[max(0, j1 - 1):j2 + 1]))
    for s, n in sigs.most_common(int(os.environ.get('TOP', '25'))):
        print(f'{n:5d} hunk in {len(files[s]):4d} file  {s}')
        for f, ee, aa in examples[s]:
            print(f'      {f}')
            for x in ee[:6]:
                print('      - ' + x[:140])
            for x in aa[:6]:
                print('      + ' + x[:140])


main()
