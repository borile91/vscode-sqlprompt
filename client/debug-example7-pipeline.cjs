#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { format } = require('./node_modules/sql-formatter/dist/cjs/index.js');
const { mapToFormatterOptions } = require('./out/formatter/formatOptionsMapper.js');
const { applySetLineJoining, applyKeywordRePadding } = require('./out/formatter/keywordPaddingFormatter.js');
const { applyDeclareFormatting } = require('./out/formatter/declareFormatter.js');
const {
  applyDdlProcFormatting,
  applyDdlParameterlessProcAsFormatting,
  applyDdlViewFormatting,
  applyDdlTableFormatting,
  applyDdlFormatting,
  applyProcBodyIndentation,
} = require('./out/formatter/ddlFormatter.js');
const { applyCaseFormatting, collapseCaseToSingleLine } = require('./out/formatter/caseFormatter.js');
const { applyLeadingCommaFormat } = require('./out/formatter/listFormatter.js');
const { applyJoinOnFormatting, applyOuterApplyInlineFormat } = require('./out/formatter/joinFormatter.js');
const { applyControlFlowIndentation, removeBlankLinesBeforeEnd } = require('./out/formatter/controlFlowFormatter.js');
const { applySemicolonFormatting } = require('./out/formatter/semicolonFormatter.js');
const { applyExecParamFormatting } = require('./out/formatter/execFormatter.js');

const EXAMPLES_ROOT = path.join(__dirname, 'src', 'formatter', '__tests__', 'examples');
const TAB_WIDTH_FALLBACK = 4;
const RETURN_CONTINUATION = ' '.repeat('RETURN '.length);
const usePatchedDdlProc = process.argv.includes('--patched-ddl-proc');
const groupsArg = process.argv.filter(a => !a.startsWith('--')).slice(2);
const groups = groupsArg.length > 0 ? groupsArg : ['1_Vertical'];

function readExample(group) {
  const dir = path.join(EXAMPLES_ROOT, group);
  const configPath = path.join(dir, 'config.json');
  const sqlPath = path.join(dir, 'example7.sql');
  return {
    group,
    configPath,
    sqlPath,
    options: JSON.parse(fs.readFileSync(configPath, 'utf8')),
    text: fs.readFileSync(sqlPath, 'utf8').trimEnd().replace(/\r\n/g, '\n'),
  };
}

function leadingSpaces(line) {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

function findCloseFromOpen(text) {
  let depth = 1;
  let inLineComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") break;
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function simulateInlineTvfReturnFix(sql) {
  const lines = sql.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const returnsMatch = line.match(/^([ \t]*)RETURNS\s*$/i);
    const tableAsReturn = i + 1 < lines.length
      ? lines[i + 1].match(/^[ \t]*TABLE\s+AS\s+RETURN\s*\((.*)$/i)
      : null;
    if (!returnsMatch || !tableAsReturn) {
      out.push(line);
      i++;
      continue;
    }

    const indent = returnsMatch[1];
    let collected = tableAsReturn[1] || '';
    let j = i + 2;
    let closeIdx = findCloseFromOpen(collected);
    while (closeIdx === -1 && j < lines.length) {
      collected += '\n' + lines[j];
      j++;
      closeIdx = findCloseFromOpen(collected);
    }
    if (closeIdx === -1) {
      out.push(line);
      i++;
      continue;
    }

    const body = collected.slice(0, closeIdx);
    const closeSuffix = collected.slice(closeIdx + 1).trim();
    const rawBodyLines = body.split('\n');
    while (rawBodyLines.length > 0 && rawBodyLines[0] === '') rawBodyLines.shift();
    const minIndent = rawBodyLines
      .filter(l => l.trim())
      .reduce((min, l) => Math.min(min, leadingSpaces(l)), Infinity);
    const baseIndent = Number.isFinite(minIndent) ? minIndent : 0;

    out.push(indent + 'RETURNS TABLE');
    out.push(indent + 'AS');
    out.push(indent + 'RETURN (');
    for (const bodyLine of rawBodyLines) {
      if (!bodyLine.trim()) {
        out.push('');
        continue;
      }
      out.push(indent + RETURN_CONTINUATION + bodyLine.slice(baseIndent));
    }
    out.push(indent + ')' + (closeSuffix ? closeSuffix : ''));
    i = j;
  }
  return out.join('\n');
}

function showSlice(stepName, sql) {
  const lines = sql.split('\n');
  let idx = lines.findIndex(l => /RETURNS\b/i.test(l));
  if (idx === -1) idx = lines.findIndex(l => /RETURN\s*\(/i.test(l));
  if (idx === -1) idx = 0;
  const start = Math.max(0, idx - 1);
  const end = Math.min(lines.length, idx + 10);
  console.log(`\n=== ${stepName} ===`);
  for (let i = start; i < end; i++) {
    console.log(`${String(i).padStart(3)} [${String(leadingSpaces(lines[i])).padStart(2)}] |${lines[i]}|`);
  }
}

function applyInlineClausePacking(formatted, options, tabWidth) {
  if (options.lists?.placeSubsequentItemsOnNewLines !== 'never') return formatted;
  const maxLen = options.whitespace?.wrapLinesLongerThan ?? 9999;
  const INLINE_CLAUSE = /^([ \t]*)(SELECT|FROM|WHERE|ORDER\s+BY)(\s*)$/i;
  const PACK_CLAUSE = /^([ \t]*)(GROUP\s+BY|HAVING)(\s*)$/i;
  const JOIN_RE = /^[ \t]*(?:(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+(?:OUTER\s+)?JOIN|OUTER\s+APPLY|CROSS\s+APPLY|JOIN)\b/i;
  const lines = formatted.split('\n');
  const out = [];
  let j = 0;
  let parenDepth = 0;
  while (j < lines.length) {
    const line = lines[j];
    const lineParens = (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);
    const im = parenDepth === 0 ? line.match(INLINE_CLAUSE) : null;
    const pm = !im && parenDepth === 0 ? line.match(PACK_CLAUSE) : null;
    if (im || pm) {
      const kwIndent = (im || pm)[1];
      const kw = (im || pm)[2].replace(/\s+/g, ' ');
      const contIndent = kwIndent + ' '.repeat(tabWidth);
      const items = [];
      j++;
      while (j < lines.length) {
        const cl = lines[j];
        if (!cl.startsWith(contIndent)) break;
        const rest = cl.slice(contIndent.length);
        if (!rest.trim()) break;
        if (JOIN_RE.test(cl)) break;
        items.push(rest.replace(/,\s*$/, '').trim());
        j++;
      }
      if (items.length === 0) {
        out.push(line);
        continue;
      }
      const rawJoined = items.join(', ').replace(/,\s*(AND|OR)\s+/gi, ' $1 ');
      if (im) {
        const prefix = kwIndent + kw + ' ';
        if (prefix.length + rawJoined.length <= maxLen) {
          out.push(prefix + rawJoined);
        } else {
          let cur = prefix + items[0];
          for (let k = 1; k < items.length; k++) {
            const add = ', ' + items[k];
            if (cur.length + add.length <= maxLen) cur += add;
            else {
              out.push(cur + ',');
              cur = contIndent + items[k];
            }
          }
          out.push(cur);
        }
      } else {
        out.push(kwIndent + kw);
        let cur = contIndent + items[0];
        for (let k = 1; k < items.length; k++) {
          const add = ', ' + items[k];
          if (cur.length + add.length <= maxLen) cur += add;
          else {
            out.push(cur + ',');
            cur = contIndent + items[k];
          }
        }
        out.push(cur);
      }
      continue;
    }
    out.push(line);
    parenDepth += lineParens;
    j++;
  }
  return out.join('\n');
}

function applyExecPacking(formatted, options, tabWidth) {
  if (options.lists?.placeSubsequentItemsOnNewLines !== 'never' || !options.whitespace?.wrapLinesLongerThan) {
    return formatted;
  }
  const maxLen = options.whitespace.wrapLinesLongerThan;
  const EXEC_FIRST_RE = /^([ \t]*EXEC(?:UTE)?\s+\S+)([ \t]+@\S+[^,\n]*,)\s*$/i;
  const EXEC_CONT_RE = /^(@\S[^\n]*?)([,;])\s*$/;
  const execLines = formatted.split('\n');
  const execResult = [];
  let i = 0;
  while (i < execLines.length) {
    const line = execLines[i];
    const execM = line.match(EXEC_FIRST_RE);
    if (!execM) {
      execResult.push(line);
      i++;
      continue;
    }
    const firstParam = execM[2].trim().replace(/,\s*$/, '');
    const indent = line.match(/^([ \t]*)/)[1];
    const params = [firstParam];
    i++;
    let terminator = ',';
    while (i < execLines.length) {
      const cm = execLines[i].trim().match(EXEC_CONT_RE);
      if (!cm) break;
      params.push(cm[1]);
      terminator = cm[2];
      i++;
      if (cm[2] === ';') break;
    }
    const contPad = indent + ' '.repeat(tabWidth);
    let packed = execM[1] + ' ' + params[0];
    for (let pi = 1; pi < params.length; pi++) {
      const candidate = packed + ', ' + params[pi];
      if (candidate.length <= maxLen) packed = candidate;
      else {
        execResult.push(packed + ',');
        packed = contPad + params[pi];
      }
    }
    execResult.push(packed + terminator);
  }
  return execResult.join('\n');
}

function applyScriptingPostProcessing(formatted, options, tabWidth) {
  if (options.lists?.placeSubsequentItemsOnNewLines !== 'never') return formatted;
  const scMaxLen = options.whitespace?.wrapLinesLongerThan ?? 9999;
  const scCollapseMax = options.dml?.collapseStatementsShorterThan ?? Infinity;
  const scCfMax = options.controlFlow?.collapseStatementsShorterThan ?? Infinity;

  if (!options.lists?.placeCommasBeforeItems) {
    const dLines = formatted.split('\n');
    const dResult = [];
    let di = 0;
    while (di < dLines.length) {
      const dl = dLines[di];
      const dm = dl.match(/^([ \t]*)(DECLARE\s+)(@\S+[^\n]*),\s*$/i);
      if (!dm) {
        dResult.push(dl);
        di++;
        continue;
      }
      const declIndent = dm[1];
      const contIndent = declIndent + ' '.repeat(tabWidth);
      const vars = [dm[3].trim()];
      let hasSemicolon = false;
      di++;
      while (di < dLines.length) {
        const cl = dLines[di].trimStart();
        if (!cl.startsWith('@')) break;
        hasSemicolon = cl.endsWith(';');
        vars.push(cl.replace(/[,;]\s*$/, '').trim());
        di++;
        if (hasSemicolon) break;
      }
      if (vars.length <= 1) {
        dResult.push(dl);
        continue;
      }
      let cur = declIndent + 'DECLARE ' + vars[0];
      for (let vi = 1; vi < vars.length; vi++) {
        const cand = cur + ', ' + vars[vi];
        if (cand.length > scMaxLen) {
          dResult.push(cur + ',');
          cur = contIndent + vars[vi];
        } else cur = cand;
      }
      dResult.push(cur + (hasSemicolon ? ';' : ''));
    }
    formatted = dResult.join('\n');
  }

  formatted = formatted.replace(/^([ \t]*INSERT(?:\s+INTO)?)\n([ \t]+)(\S[^\n]*)/gim, (_, kw, _ind, rest) => `${kw} ${rest.trim()}`);
  formatted = formatted.replace(/^([ \t]*VALUES)\n[ \t]+(\S[^\n]*)/gim, (_, kw, rest) => `${kw} ${rest.trim()}`);

  if (isFinite(scCollapseMax) && !options.lists?.placeCommasBeforeItems) {
    formatted = formatted.replace(/^([ \t]*INSERT(?:\s+INTO)?[^\n]+)\n([ \t]*VALUES\s+\([^\n]*;)$/gim, (m, ins, vals) => {
      const one = ins + ' ' + vals.trimStart();
      return one.length < scCollapseMax ? one : m;
    });
  }

  formatted = formatted.replace(/^([ \t]*SET\s+[^\n]+,)\n([ \t]+)(\S[^\n]*)$/gim, (m, setLine, _ind, rest) => {
    const one = setLine + ' ' + rest.trim();
    return one.length <= scMaxLen ? one : m;
  });

  if (isFinite(scCollapseMax) && !options.lists?.placeCommasBeforeItems) {
    formatted = formatted.replace(/^([ \t]*UPDATE\s+\S+)\n([ \t]*SET\s+[^\n]+)\n([ \t]*WHERE\s+[^\n]+;)$/gim, (m, upd, set, whr) => {
      const one = upd + ' ' + set.trimStart() + ' ' + whr.trimStart();
      return one.length < scCollapseMax ? one : m;
    });
    formatted = formatted.replace(/^([ \t]*UPDATE\s+\S+)\n([ \t]*SET\s+[^\n]+;)$/gim, (m, upd, set) => {
      const one = upd + ' ' + set.trimStart();
      return one.length < scCollapseMax ? one : m;
    });
  }

  if (!options.lists?.placeCommasBeforeItems && (options.dml?.collapseSubqueriesShorterThan ?? Infinity) < Infinity) {
    const eLines = formatted.split('\n');
    const eResult = [];
    let ei = 0;
    while (ei < eLines.length) {
      const el = eLines[ei];
      const em = el.match(/^([ \t]*)((?:ELSE\s+)?IF\s+(?:NOT\s+)?EXISTS\s*)\(\s*$/i);
      if (!em) {
        eResult.push(el);
        ei++;
        continue;
      }
      const ifIndent = em[1];
      const ifPart = em[2].replace(/\s+/g, ' ').trimEnd();
      const bodyIndent = ifIndent + ' '.repeat(tabWidth * 2);
      const bodyLines = [];
      ei++;
      let foundClose = false;
      while (ei < eLines.length) {
        const bl = eLines[ei];
        if (/^\s*$/.test(bl) && !foundClose) {
          ei++;
          continue;
        }
        if (bl === ifIndent + ')') {
          foundClose = true;
          ei++;
          break;
        }
        bodyLines.push(bl);
        ei++;
      }
      if (!foundClose) {
        eResult.push(el, ...bodyLines);
        continue;
      }
      const parts = [];
      let bi = 0;
      while (bi < bodyLines.length) {
        const bl = bodyLines[bi];
        const trimmed = bl.trimStart();
        const km = trimmed.match(/^(SELECT|FROM|WHERE)\s*$/i);
        if (km) {
          const kw = km[1].toUpperCase();
          bi++;
          const items = [];
          while (bi < bodyLines.length && bodyLines[bi].startsWith(bodyIndent)) {
            items.push(bodyLines[bi].trim());
            bi++;
          }
          parts.push(kw + (items.length > 0 ? ' ' + items.join(' ') : ''));
        } else if (trimmed) {
          parts.push(trimmed);
          bi++;
        } else bi++;
      }
      const one = ifIndent + ifPart + ' (' + parts.join(' ') + ')';
      if (one.length <= scMaxLen) eResult.push(one);
      else eResult.push(el, ...bodyLines, ifIndent + ')');
    }
    formatted = eResult.join('\n');
  }

  if (isFinite(scCfMax) && !options.lists?.placeCommasBeforeItems) {
    formatted = formatted.replace(/^([ \t]*(?:ELSE\s+)?IF\b[^\n]+)\n([ \t]+(?:AND|OR)\b[^\n]+)$/gim, (m, ifLine, andLine) => {
      const one = ifLine + ' ' + andLine.trimStart();
      return one.length < scCfMax ? one : m;
    });
  }

  return formatted;
}

function applyTailCleanup(formatted, options, spacesInside) {
  formatted = applyExecParamFormatting(formatted, options);
  formatted = removeBlankLinesBeforeEnd(formatted);
  formatted = formatted.replace(/\n\n+([ \t]*GO\b[ \t]*)(?=\n)/gi, '\n$1\n\n');
  formatted = formatted.replace(/\n\n+([ \t]*GO\b[ \t]*)$/gi, '\n$1');
  formatted = formatted.replace(/(^[ \t]*GO\b[ \t]*)\n{3,}/gim, '$1\n\n');
  if ((options.whitespace?.newLines?.emptyLinesAfterBatchSeparator ?? 1) === 0) {
    formatted = formatted.replace(/^([ \t]*GO\b[ \t]*)\n\n/gim, '$1\n');
  }
  formatted = formatted.replace(/([ \t]*SET[ \t]+@\w+[^\n]*\n)\n+([ \t]*SET[ \t]+@\w+)/gm, '$1$2');
  formatted = formatted.replace(/^([ \t]*)SET[ \t]*\n[ \t]*([A-Z_])/gim, '$1SET $2');
  formatted = formatted.replace(/\bSET\s+([A-Z_][A-Z_0-9]*)\s{2,}([A-Z_0-9])/g, 'SET $1 $2');
  formatted = formatted.replace(/\bALTER\s{2,}TABLE\b/g, 'ALTER TABLE');
  formatted = formatted.replace(/\bADD\s{2,}CONSTRAINT\b/g, 'ADD CONSTRAINT');
  formatted = formatted.replace(/^(ALTER\s+TABLE[^\n]+\n)(WITH)\n[ \t]*(CHECK)\b/gim, '$1$2 $3');
  formatted = formatted.replace(/^(ALTER TABLE[^\n]+)\n(WITH CHECK)/gim, '$1 $2');
  if (options.ddl?.collapseShortStatements) {
    formatted = formatted.replace(/^(ALTER\s+TABLE\s+\S+)\n(ADD\s+CONSTRAINT\s+.+)$/gim, (m, p1, p2) => {
      const joined = `${p1} ${p2}`;
      return joined.length < 97 ? joined : m;
    });
  }
  if (spacesInside) {
    formatted = formatted.replace(/\bDEFAULT\s*\(\(([^)]+)\)\)/g, 'DEFAULT (( $1 ))');
    formatted = formatted.replace(/\bDEFAULT\s*\((?!\()([^)]+\))/g, 'DEFAULT ( $1');
    formatted = formatted.replace(/\bFOREIGN KEY\s*\(([^)]+)\)/g, 'FOREIGN KEY ( $1 )');
  }
  const expandConstraint = options.ddl?.placeConstraintColumnsOnNewLines === 'ifLongerOrMultipleColumns';
  if (expandConstraint) {
    formatted = formatted.replace(/^(ADD CONSTRAINT \S+ )(FOREIGN KEY) (\([^)]+\)) (REFERENCES \S+) (\([^)]+\))(.*)$/gim, (_m, prefix, fkKw, fkParens, refPart, refParens, tail) => {
      const fkCols = fkParens.replace(/^\(\s*|\s*\)$/g, '').split(',').map(c => c.trim()).filter(Boolean);
      const refCols = refParens.replace(/^\(\s*|\s*\)$/g, '').split(',').map(c => c.trim()).filter(Boolean);
      if (fkCols.length <= 1 && refCols.length <= 1) return _m;
      const fkColIndent = prefix.length;
      const firstPad = ' '.repeat(fkColIndent);
      const commaPad = ' '.repeat(fkColIndent - 2);
      const resultLines = [`${prefix}${fkKw} (`];
      for (let idx = 0; idx < fkCols.length - 1; idx++) {
        resultLines.push(idx === 0 ? `${firstPad}${fkCols[idx]}` : `${commaPad}, ${fkCols[idx]}`);
      }
      const lastFkCol = fkCols[fkCols.length - 1];
      const lastFkLine = fkCols.length === 1 ? `${firstPad}${lastFkCol}` : `${commaPad}, ${lastFkCol}`;
      resultLines.push(`${lastFkLine} ) ${refPart} (`);
      for (let idx = 0; idx < refCols.length - 1; idx++) {
        resultLines.push(idx === 0 ? `${firstPad}${refCols[idx]}` : `${commaPad}, ${refCols[idx]}`);
      }
      const lastRefCol = refCols[refCols.length - 1];
      const lastRefLine = refCols.length === 1 ? `${firstPad}${lastRefCol}` : `${commaPad}, ${lastRefCol}`;
      resultLines.push(`${lastRefLine} )${tail}`);
      return resultLines.join('\n');
    });
  }
  if (options.whitespace?.wrapLinesLongerThan !== undefined && isFinite(options.whitespace.wrapLinesLongerThan)) {
    formatted = formatted.replace(/^(ADD CONSTRAINT \S+ )(FOREIGN KEY \([^)\n]+\) REFERENCES \S+)( \([^)\n]+\).+)$/gim, (fullMatch, prefix, fkPart, refCols) => {
      if (fullMatch.length <= options.whitespace.wrapLinesLongerThan) return fullMatch;
      const indent = ' '.repeat(prefix.length);
      const trimmedRefCols = refCols.trim();
      const spacedRefCols = spacesInside
        ? trimmedRefCols.replace(/^\(([^)\n]+)\)/, (_m, cols) => `( ${cols.trim()} )`)
        : trimmedRefCols;
      return `${prefix}${fkPart}\n${indent}${spacedRefCols}`;
    });
  }
  formatted = formatted.replace(/\n\n\n([ \t]{4,})/gm, '\n\n$1');
  if (options.lists?.placeSubsequentItemsOnNewLines === 'never' && !options.lists?.placeCommasBeforeItems) {
    formatted = formatted.replace(/^(.+;)\n(?=[ \t]*(?!ELSE\b|END\b|CATCH\b|GO\b)\S)/gm, '$1\n\n');
  } else if (options.lists?.placeSubsequentItemsOnNewLines === 'never') {
    formatted = formatted.replace(/^(.+;)\n(?=        (?!ELSE\b|END\b|CATCH\b)\S)/gm, '$1\n\n');
  }
  formatted = formatted.replace(/([ \t]*DECLARE[ \t]+@[^\n]+;[ \t]*\n)\n([ \t]*DECLARE[ \t]+@)/gm, '$1$2');
  if (options.lists?.placeSubsequentItemsOnNewLines === 'never' && !options.lists?.placeCommasBeforeItems) {
    formatted = formatted.replace(/([ \t]*SET[ \t]+@\w[^\n]+;[ \t]*\n)\n([ \t]*SET[ \t]+@\w)/gm, '$1$2');
  }
  const wrapMaxLen = options.whitespace?.wrapLinesLongerThan;
  if (wrapMaxLen !== undefined && isFinite(wrapMaxLen) && options.whitespace?.wrapLongLines !== false) {
    formatted = formatted
      .split('\n')
      .flatMap((line) => {
        if (line.length <= wrapMaxLen) return [line];
        const m = line.match(/^([ \t]+SET[ \t]+@\w+[ \t]*=[ \t]*)/i);
        if (!m) return [line];
        const cutAt = line.lastIndexOf(' + ', wrapMaxLen - 1);
        if (cutAt <= m[1].length) return [line];
        const cont = ' '.repeat(m[1].length) + '+ ' + line.substring(cutAt + 3);
        return [line.substring(0, cutAt), cont];
      })
      .join('\n');
  }
  formatted = formatted.replace(/^([ \t]*[^\n]*?(?:NOT\s+)?EXISTS\s*\()\n[ \t]*(SELECT[^\n]*)\n((?:[ \t]*(?:FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY)[^\n]*\n)+)[ \t]*\)/gim, (_, openPart, select, restClauses) => {
    const sp = spacesInside ? ' ' : '';
    const contentIndent = ' '.repeat(openPart.length + sp.length);
    const clauses = restClauses
      .trimEnd()
      .split('\n')
      .map(l => contentIndent + l.trim())
      .join('\n');
    return openPart + sp + select + '\n' + clauses + (spacesInside ? ' )' : ')');
  });
  formatted = formatted.replace(/(\.\w+)[ \t]+\(/g, '$1(');
  formatted = formatted.replace(/^(CREATE\s+TABLE\s+\S+)\(/gim, '$1 (');
  formatted = formatted.replace(/^((?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|PROC)\s+\S+)\(/gim, '$1 (');
  formatted = formatted.replace(/\bREFERENCES\s+([^\s(]+)\(/g, 'REFERENCES $1 (');
  if (expandConstraint) formatted = formatted.replace(/\bREFERENCES (\S+)\($/gm, 'REFERENCES $1 (');
  if (spacesInside) formatted = formatted.replace(/\bREFERENCES\s+([^\s(]+)[ \t]*\(([^)\n]+)\)/g, 'REFERENCES $1 ( $2 )');
  if (options.insertStatements?.columns?.parenthesisStyle) {
    formatted = formatted.replace(/^([ \t]*INSERT\s+(?:INTO\s+)?[^\s(]+)\(/gim, '$1 (');
  }
  formatted = formatted.replace(/\bRAISERROR\s+\(/gi, 'RAISERROR(');
  if (spacesInside) {
    formatted = formatted.replace(/\((NOLOCK|UPDLOCK|ROWLOCK|TABLOCK|TABLOCKX|HOLDLOCK|READPAST|NOWAIT|READCOMMITTEDLOCK|REPEATABLEREAD|SERIALIZABLE|SNAPSHOT|FORCESCAN|FORCESEEK|PAGLOCK)\)/gi, '( $1 )');
    formatted = formatted.replace(/^([ \t]*VALUES\s*\()(.+)\)([ \t]*;?[ \t]*)$/gim, (_m, kw, content, suffix) => {
      const c = content.trim();
      return `${kw} ${c}${c.endsWith(')') ? '' : ' '})${suffix}`;
    });
  }
  formatted = formatted.replace(/^((?:[ \t]*--[^\n]*\n)+)(?=\S)/, '$1\n');
  return formatted;
}

function runPipeline(example) {
  const options = example.options;
  const tabWidth = options.whitespace?.numberOfSpacesInTabs ?? TAB_WIDTH_FALLBACK;
  const spacesInside = options.parentheses?.addSpacesInsideParentheses ?? false;
  const useTabular = options.joinStatements?.join?.keywordAlignment === 'toTable' && options.lists?.placeCommasBeforeItems === true;
  let formatted = example.text;

  const steps = [
    ['format (sql-formatter)', sql => format(sql, mapToFormatterOptions(options))],
    ['applySetLineJoining', sql => applySetLineJoining(sql)],
    ['GO fix', sql => sql.replace(/^([ \t]*GO\b)[ \t]+(?=[^\s\n])/gim, '$1\n\n')],
    ['applyKeywordRePadding', sql => applyKeywordRePadding(sql, useTabular)],
    ['spaces-inside-parens fixes', sql => {
      if (!spacesInside) return sql;
      return sql
        .replace(/\b((?:NOT\s+)?IN|TOP|(?:NOT\s+)?EXISTS|ANY|ALL|SOME)\s*\(([^()\n]+)\)/gi, (_m, kw, content) => `${kw} ( ${content.trim()} )`)
        .replace(/\b(IF|WHILE)\b(\s+)\(([^()\n]+)\)/gi, (_m, kw, sp, content) => `${kw}${sp}( ${content.trim()} )`);
    }],
    ['IF/WHILE expansion', sql => {
      if (options.controlFlow?.collapseShortStatements) return sql;
      return sql.replace(/^([ \t]*)(IF|WHILE)\b(.*?)[ \t]+((?:COMMIT|ROLLBACK|RETURN|BREAK|CONTINUE|RAISERROR|EXEC|INSERT|UPDATE|DELETE|SELECT|SET\s+@)[^;\n]*;)$/gim, (_, indent, kw, condition, body) => `${indent}${kw}${condition}\n${indent}${body}`);
    }],
    ['applyDeclareFormatting', sql => applyDeclareFormatting(sql, options)],
    [usePatchedDdlProc ? 'applyDdlProcFormatting (+ simulated iTVF fix)' : 'applyDdlProcFormatting', sql => {
      let out = applyDdlProcFormatting(sql, options, tabWidth);
      if (usePatchedDdlProc) out = simulateInlineTvfReturnFix(out);
      return out;
    }],
    ['applyDdlParameterlessProcAsFormatting', sql => applyDdlParameterlessProcAsFormatting(sql, options)],
    ['applyDdlViewFormatting', sql => applyDdlViewFormatting(sql, options)],
    ['applyDdlTableFormatting', sql => applyDdlTableFormatting(sql, options)],
    ['applyLeadingCommaFormat', sql => applyLeadingCommaFormat(sql, options)],
    ['collapseCaseToSingleLine', sql => collapseCaseToSingleLine(sql, options)],
    ['inline clause packing', sql => applyInlineClausePacking(sql, options, tabWidth)],
    ['applyJoinOnFormatting', sql => applyJoinOnFormatting(sql, options, tabWidth)],
    ['applyCaseFormatting', sql => applyCaseFormatting(sql, options, tabWidth)],
    ['applyDdlFormatting', sql => applyDdlFormatting(sql, options)],
    ['applyControlFlowIndentation', sql => applyControlFlowIndentation(sql, options, tabWidth)],
    ['applySemicolonFormatting', sql => applySemicolonFormatting(sql, options)],
    ['applyProcBodyIndentation', sql => applyProcBodyIndentation(sql, options, tabWidth)],
    ['collapseShortStatements', sql => {
      if (!options.controlFlow?.collapseShortStatements) return sql;
      const maxCollapse = options.controlFlow?.collapseStatementsShorterThan ?? Infinity;
      return sql.replace(/^([ \t]*)(IF|WHILE)(\b[^\n]*)\n([ \t]+)(\S[^;\n]*;)$/gim, (match, indent, kw, condition, bodyIndent, body) => {
        if (bodyIndent.length !== indent.length + tabWidth) return match;
        const combined = indent + kw + condition + ' ' + body;
        return combined.length < maxCollapse ? combined : match;
      });
    }],
    ['applyOuterApplyInlineFormat', sql => applyOuterApplyInlineFormat(sql, spacesInside)],
    ['wrapLongLines patches', sql => applyScriptingPostProcessing(applyExecPacking(sql, options, tabWidth), options, tabWidth)],
    ['applyExecParamFormatting + tail cleanup', sql => applyTailCleanup(sql, options, spacesInside)],
  ];

  console.log(`\n### ${example.group}${usePatchedDdlProc ? ' (patched ddl proc simulation)' : ''}`);
  showSlice('input', formatted);
  for (const [name, fn] of steps) {
    formatted = fn(formatted);
    showSlice(name, formatted);
  }
}

for (const group of groups) runPipeline(readExample(group));
