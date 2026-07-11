import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { backupService } from '../core/backup/backupService';
import { db } from '../db/localDb';

// Samples are deliberately gitignored. CI skips this suite; a developer with
// the supplied anonymised backup gets a real v4 -> v5 migration regression.
const backupPath = resolve(process.cwd(), '../../samples/backup/stock-ledger-backup-20260708-121409.json');
const localDescribe = existsSync(backupPath) ? describe : describe.skip;

localDescribe('local anonymised v4 migration sample', () => {
  beforeEach(async () => {
    await db.ledgers.clear();
    await db.transactions.clear();
    await db.appSettings.clear();
    await db.backupImportRecords.clear();
  });

  it('imports the supplied v4 backup and exports a semantically complete v5 backup', async () => {
    const preview = backupService.parseBackup(readFileSync(backupPath, 'utf8'));
    expect(preview.sourceVersion).toBe(4);
    expect(preview.transactionsCount).toBeGreaterThan(0);

    const imported = await backupService.importBackup(preview.rawParsedData, 'OVERWRITE', 'local-v4-sample.json');
    expect(imported.transactionCount + imported.duplicateCount + imported.conflictCount).toBe(preview.transactionsCount);

    const exported = await backupService.exportBackup();
    expect(exported.format).toBe('recoder-backup-v5');
    expect(exported.version).toBe(5);
    expect(exported.transactions).toHaveLength(await db.transactions.count());
    expect(exported.ledgers).toHaveLength(await db.ledgers.count());
  });
});
