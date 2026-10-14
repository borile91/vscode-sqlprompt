import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    AtomicWriteFs,
    TEMP_FILE_SUFFIX,
    tempFileName,
    writeFileAtomic,
} from '../atomicWrite.js';

/** `fs` di Node nella forma attesa da `writeFileAtomic`. */
const nodeFs: AtomicWriteFs<string> = {
    writeFile: (file, data) => fsp.writeFile(file, data),
    rename: (source, target) => fsp.rename(source, target),
    delete: (file) => fsp.rm(file, { force: true }),
};

const dirs: string[] = [];
async function tempDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sqlprompt-atomic-'));
    dirs.push(dir);
    return dir;
}

after(async () => {
    for (const dir of dirs) {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

describe('tempFileName', () => {
    it('genera nomi univoci accanto al file, con suffisso .tmp', () => {
        const a = tempFileName('abc.json');
        const b = tempFileName('abc.json');
        assert.notEqual(a, b);
        assert.ok(a.startsWith('abc.json.'));
        assert.ok(a.endsWith(TEMP_FILE_SUFFIX));
        assert.ok(!a.endsWith('.json'));
    });
});

describe('writeFileAtomic', () => {
    it('scrive il contenuto e non lascia temporanei', async () => {
        const dir = await tempDir();
        const target = path.join(dir, 'entry.json');

        await writeFileAtomic(nodeFs, target, path.join(dir, tempFileName('entry.json')), Buffer.from('{"a":1}'));

        assert.equal(await fsp.readFile(target, 'utf8'), '{"a":1}');
        assert.deepEqual(await fsp.readdir(dir), ['entry.json']);
    });

    it('con scritture concorrenti lascia un JSON intero di una delle due', async () => {
        const dir = await tempDir();
        const target = path.join(dir, 'entry.json');
        const payloads = Array.from({ length: 12 }, (_, i) =>
            JSON.stringify({ writer: i, data: 'x'.repeat(200_000 + i) }),
        );

        await Promise.all(
            payloads.map((p) =>
                writeFileAtomic(nodeFs, target, path.join(dir, tempFileName('entry.json')), Buffer.from(p)),
            ),
        );

        const written = await fsp.readFile(target, 'utf8');
        assert.ok(payloads.includes(written));
        assert.doesNotThrow(() => JSON.parse(written));
        assert.deepEqual(await fsp.readdir(dir), ['entry.json']);
    });

    it('se il rename fallisce rimuove il temporaneo e rilancia', async () => {
        const dir = await tempDir();
        const temp = path.join(dir, tempFileName('entry.json'));
        const failingFs: AtomicWriteFs<string> = {
            ...nodeFs,
            rename: async () => {
                throw new Error('rename failed');
            },
        };

        await assert.rejects(
            () => writeFileAtomic(failingFs, path.join(dir, 'entry.json'), temp, Buffer.from('{}')),
            /rename failed/,
        );
        assert.deepEqual(await fsp.readdir(dir), []);
    });
});
