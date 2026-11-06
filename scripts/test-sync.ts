import { SyncService } from '../src/services/syncService.ts';

async function main() {
  console.log('================================================================');
  console.log(' Instagram Saved Reels Sync Runner');
  console.log('================================================================\n');

  const syncService = new SyncService();
  const maxPages = Number(process.argv[2]) || 3;

  console.log(`Starting sync for up to ${maxPages} pages...`);
  const result = await syncService.syncSavedReels(maxPages);

  if (!result.success) {
    console.error('\n❌ Sync failed:', result.error.message);
    process.exit(1);
  }

  console.log('\n✅ Sync successfully completed!');
  console.log(`- Pages Fetched:     ${result.data.pagesFetched}`);
  console.log(`- Reels Processed:   ${result.data.reelsProcessed}`);
  console.log(`- New Saved Reels:   ${result.data.newReelsCount}`);
  console.log(`- Creators Updated:  ${result.data.creatorsUpserted}`);
  console.log(`- Finished At:       ${result.data.completedAt}\n`);
}

main().catch(console.error);
