import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryResponse } from '../../shared/contracts/memory.js';
import type { SampleAudit } from './audit.js';

// A sample filed under the wrong person names that person's face as its owner
// (live: one of "Rapha"'s samples was nearest to Flo's, and named Flo
// "Rapha"). The memory view flags such samples so the operator can move or
// remove them; it must flag what the audit script reports, from the same
// numbers, without the embeddings ever leaving the server.
//
// The library: public domain portraits (tests/fixtures/faces), with Obama's
// 2009 photo filed under "Harris" on purpose.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtures = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/faces/browser-embeddings.json'), 'utf8')) as {
  images: Record<string, { faces: Array<{ embedding: number[] }> }>;
};
const embeddingOf = (image: string, index = 0) => fixtures.images[image]!.faces[index]!.embedding;
const sample = (id: string, name: string, image: string, createdAt: number, index = 0) => ({ id, name, embedding: embeddingOf(image, index), createdAt, thumbnail: `data:image/jpeg;base64,${Buffer.from(id).toString('base64')}` });
const LIBRARY = {
  faces: [
    sample('obama-2012', 'Obama', 'obama-2012.jpg', 1),
    sample('harris-2021', 'Harris', 'harris-2021.jpg', 2),
    sample('planted', 'Harris', 'obama-2009.jpg', 3),
    sample('biden-2021', 'Biden', 'biden-2021.jpg', 4),
    sample('crew-a', 'Crew A', 'apollo-11-crew.jpg', 5, 0),
    sample('crew-b', 'Crew B', 'apollo-11-crew.jpg', 6, 1),
  ],
};

const dir = mkdtempSync(path.join(os.tmpdir(), 'tubs-audit-'));
const libraryFile = path.join(dir, 'face-library.json');
writeFileSync(libraryFile, JSON.stringify(LIBRARY));
process.env.TUBS_FACE_LIBRARY = libraryFile;
const { auditSamples } = await import('./audit.js');
const { handleApiRequest } = await import('../routes/api.js');

let server: http.Server;
let base = '';
beforeAll(async () => {
  server = http.createServer((request, response) => void handleApiRequest(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const byId = (audit: SampleAudit[]) => new Map(audit.map((entry) => [entry.id, entry]));

describe('the library audit', () => {
  it('flags the misfiled photo as looking like its real owner and unlike its supposed one', () => {
    const audit = byId(auditSamples(LIBRARY.faces));
    const planted = audit.get('planted')!;
    expect(planted.flags.looksLike?.name).toBe('Obama');
    expect(planted.flags.looksLike!.sim).toBeGreaterThan(0.65);
    expect(planted.flags.unlikeOwn).toBe(true);
    expect(planted.index).toBe(2);
    // The real owner's sample resembles it back: the operator decides which is misfiled.
    expect(audit.get('obama-2012')!.flags).toEqual({ looksLike: { name: 'Harris', sim: planted.flags.looksLike!.sim }, unlikeOwn: false });
    // Nobody else is like anyone: no flags (Harris's real photo is unlike the planted one, her only other).
    expect(audit.get('biden-2021')!.flags).toEqual({ looksLike: null, unlikeOwn: false });
    expect(audit.get('crew-a')!.flags).toEqual({ looksLike: null, unlikeOwn: false });
    expect(audit.get('harris-2021')!.flags).toEqual({ looksLike: null, unlikeOwn: true });
  });

  it('says the same in the memory view, GET /memory/library/audit and the audit script, with no embeddings', async () => {
    const route = (await (await fetch(`${base}/memory/library/audit`)).json()) as { samples: SampleAudit[] };
    expect(route.samples).toEqual(auditSamples(LIBRARY.faces));
    const text = JSON.stringify(route);
    expect(text).not.toContain('embedding');
    expect(text).not.toContain(String(embeddingOf('obama-2009.jpg')[0]));

    const memory = (await (await fetch(`${base}/memory`)).json()) as MemoryResponse;
    const harris = memory.cards.find((card) => card.name === 'Harris')!;
    expect(harris.library.map((entry) => [entry.id, entry.index, entry.flag?.looksLike?.name ?? null, entry.flag?.unlikeOwn ?? false]))
      .toEqual([['harris-2021', 1, null, true], ['planted', 2, 'Obama', true]]);
    expect(harris.library[1]!.flag!.like).toEqual(harris.library[1]!.flag!.looksLike);

    const out = path.join(dir, 'audit.json');
    execFileSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/scripts/face-library-audit.ts'), '--json', out], {
      env: { ...process.env, TUBS_FACE_LIBRARY: libraryFile },
      stdio: 'ignore',
    });
    const script = JSON.parse(readFileSync(out, 'utf8')) as { flagged: Array<{ id: string; flags: SampleAudit['flags'] }> };
    expect(script.flagged.map((entry) => [entry.id, entry.flags]))
      .toEqual(route.samples.filter((entry) => entry.flags.looksLike || entry.flags.unlikeOwn).map((entry) => [entry.id, entry.flags]));
  }, 30_000);
});
