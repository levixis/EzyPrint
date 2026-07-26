const admin = require('./functions/node_modules/firebase-admin');
const readline = require('readline');

// Check project ID environment or argument to avoid acting on the wrong environment
const targetProjectId = 'ezyyprint';

admin.initializeApp({
  projectId: targetProjectId
});

const db = admin.firestore();

// Helper to ask user for confirmation
function prompt(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
}

async function backfillPayoutConfigs(isDryRun = false) {
  console.log(`Initiating PaymentConfiguration Backfill Migration... ${isDryRun ? '[DRY-RUN]' : ''}`);
  const shopsSnap = await db.collection('shops').get();
  
  let migrated = 0;
  let skipped = 0;

  for (const shopDoc of shopsSnap.docs) {
    const data = shopDoc.data();
    
    // Only migrate if payoutMethods actually exists and has elements
    if (data.payoutMethods && Array.isArray(data.payoutMethods) && data.payoutMethods.length > 0) {
      const shopId = shopDoc.id;
      const configRef = db.collection('shops').doc(shopId).collection('private').doc('paymentConfig');
      
      const configSnap = await configRef.get();
      
      // Idempotency check: don't overwrite if the private schema already has data
      if (configSnap.exists && Array.isArray(configSnap.data().payoutMethods) && configSnap.data().payoutMethods.length > 0) {
        console.log(`[SKIP] Shop ${shopId} already has private paymentConfig. Ignoring.`);
        skipped++;
        continue;
      }

      console.log(`[MIGRATE] Writing ${data.payoutMethods.length} methods to private schema for Shop ${shopId}...`);
      if (!isDryRun) {
        await configRef.set({
          payoutMethods: data.payoutMethods,
          updatedAt: new Date().toISOString(),
        });
      }
      migrated++;
    } else {
      skipped++;
    }
  }
  
  console.log(`Backfill pass complete. Migrated: ${migrated}, Skipped: ${skipped}.`);
}

async function cleanupPublicConfigs(isDryRun = false) {
  console.log(`Initiating Public Data Scrubber Pass... ${isDryRun ? '[DRY-RUN]' : ''}`);
  const shopsSnap = await db.collection('shops').get();
  
  let deleted = 0;
  let skipped = 0;
  
  for (const shopDoc of shopsSnap.docs) {
    const data = shopDoc.data();
    if (data.payoutMethods !== undefined) {
      const shopId = shopDoc.id;
      
      // Safety assert: only delete if the private doc was successfully written!
      const configSnap = await db.collection('shops').doc(shopId).collection('private').doc('paymentConfig').get();
      if (!configSnap.exists || !configSnap.data().payoutMethods || configSnap.data().payoutMethods.length === 0) {
        if (data.payoutMethods && data.payoutMethods.length > 0) {
          console.log(`[UNSAFE] Shop ${shopId} has public methods but NO private config. Skipping deletion!`);
          skipped++;
          continue;
        }
      }

      console.log(`[CLEANUP] Purging public payout data from Shop ${shopId}...`);
      if (!isDryRun) {
        await shopDoc.ref.update({
          payoutMethods: admin.firestore.FieldValue.delete()
        });
      }
      deleted++;
    } else {
      skipped++;
    }
  }
  console.log(`Scrub pass complete. Purged: ${deleted}, Skipped: ${skipped}.`);
}

async function execute() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const doCleanup = args.includes('--cleanup');

  console.log('=========================================');
  console.log(`TARGET PROJECT: ${targetProjectId}`);
  console.log(`MODE: ${isDryRun ? 'DRY RUN (No writes)' : 'EXECUTION (Writes enabled)'}`);
  console.log(`CLEANUP PHASE: ${doCleanup ? 'ENABLED' : 'DISABLED'}`);
  console.log('=========================================\n');

  if (!isDryRun) {
    const answer = await prompt(`You are about to modify live data in PROJECT [${targetProjectId}]. Are you absolutely sure? (yes/no): `);
    if (answer.toLowerCase() !== 'yes') {
      console.log('Aborting execution.');
      process.exit(0);
    }
  }

  try {
    if (!doCleanup) {
      // Phase 1 is backfill
      await backfillPayoutConfigs(isDryRun);
      console.log('--- Phase 1 Success ---');
    }

    // Per requirements, sequence this properly. ONLY run cleanup if requested.
    if (doCleanup) {
      await cleanupPublicConfigs(isDryRun);
      console.log('--- Phase 2 Success ---');
    } else {
      console.log('--- Phase 2 Skipped. Run with --cleanup to trigger deletion. ---');
    }
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

execute();
