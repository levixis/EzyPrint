const admin = require('firebase-admin');
const serviceAccount = require('/Users/harshvardhanjha/Desktop/ezyprintkeys/ezyyprint-firebase-adminsdk-fbsvc-a247a26857.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

async function wipeDatabase() {
  console.log('Starting database reset...');

  try {
    // 1. Find the admin user(s) to protect them
    const usersSnapshot = await db.collection('users').where('type', '==', 'ADMIN').get();
    const adminUids = [];
    usersSnapshot.forEach(doc => {
      adminUids.push(doc.id);
      console.log(`Protected Admin User: ${doc.data().email} (UID: ${doc.id})`);
    });

    if (adminUids.length === 0) {
      console.warn('⚠️ WARNING: No admin users found! If you proceed, you will have NO access to the dashboard. Please create an admin first, or modify this script.');
      process.exit(1);
    }

    // 2. Delete Firestore Collections (except admin users)
    const collectionsToDelete = ['shops', 'orders', 'payouts'];
    
    for (const collectionName of collectionsToDelete) {
      console.log(`Deleting collection: ${collectionName}...`);
      const snapshot = await db.collection(collectionName).get();
      const batch = db.batch();
      let count = 0;
      snapshot.forEach(doc => {
        batch.delete(doc.ref);
        count++;
      });
      if (count > 0) {
        await batch.commit();
        console.log(`✅ Deleted ${count} documents from ${collectionName}`);
      } else {
        console.log(`ℹ️ Collection ${collectionName} is already empty.`);
      }
    }

    // Delete non-admin users from Firestore
    console.log('Deleting non-admin users from Firestore...');
    const allUsersSnapshot = await db.collection('users').get();
    const userBatch = db.batch();
    let userDocCount = 0;
    allUsersSnapshot.forEach(doc => {
      if (!adminUids.includes(doc.id)) {
        userBatch.delete(doc.ref);
        userDocCount++;
      }
    });
    if (userDocCount > 0) {
      await userBatch.commit();
      console.log(`✅ Deleted ${userDocCount} non-admin user documents from Firestore.`);
    }

    // 3. Delete from Firebase Authentication
    console.log('Deleting non-admin users from Firebase Auth...');
    let nextPageToken;
    let authDeleteCount = 0;
    do {
      const listUsersResult = await auth.listUsers(1000, nextPageToken);
      const uidsToDelete = [];
      
      listUsersResult.users.forEach((userRecord) => {
        if (!adminUids.includes(userRecord.uid)) {
          uidsToDelete.push(userRecord.uid);
        }
      });
      
      if (uidsToDelete.length > 0) {
         const deleteResult = await auth.deleteUsers(uidsToDelete);
         authDeleteCount += deleteResult.successCount;
      }
      
      nextPageToken = listUsersResult.pageToken;
    } while (nextPageToken);

    console.log(`✅ Deleted ${authDeleteCount} non-admin users from Firebase Auth.`);
    console.log('\n🎉 Database Wipe Complete! Your app is now a clean slate (Admin retained).');

  } catch (error) {
    console.error('Error during wipe:', error);
  }
}

wipeDatabase();
