import fs from 'node:fs';
import path from 'node:path';
import { ArchiveImportService } from '../src/services/archiveImportService.ts';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log('Usage: node --experimental-strip-types scripts/import-instagram-export.ts <path-to-saved_posts.json>');
    console.log('\nExample:');
    console.log('  node --experimental-strip-types scripts/import-instagram-export.ts ~/Downloads/saved_posts.json\n');
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`❌ File not found at: ${resolved}`);
    process.exit(1);
  }

  console.log('================================================================');
  console.log(' 📥 Reeler Instagram Archive Importer');
  console.log('================================================================');
  console.log(`Reading archive: ${resolved}...`);

  const fileContent = fs.readFileSync(resolved, 'utf-8');
  const result = await ArchiveImportService.importArchive(fileContent);

  console.log('\n✅ Import Completed!');
  console.log(`- Total Items Scanned:  ${result.totalProcessed}`);
  console.log(`- Newly Imported Reels: ${result.reelsImported}`);
  console.log(`- Already in Library:   ${result.alreadyPresent}`);
  console.log(`- Creators Added:       ${result.creatorsAdded}`);
  console.log(`- Skipped / Non-reels:  ${result.skipped}`);

  if (result.errors.length > 0) {
    console.log('\n⚠️ Errors encountered during import:');
    result.errors.forEach(e => console.log(`  • ${e}`));
    if (result.reelsImported === 0 && result.alreadyPresent === 0) {
      console.error('\n❌ Import failed: No reels could be imported.');
      process.exit(1);
    }
  }
  console.log('================================================================\n');
}

main().catch(err => {
  console.error('Fatal import error:', err);
  process.exit(1);
});
