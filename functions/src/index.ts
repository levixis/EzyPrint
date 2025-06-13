
import { onSchedule, ScheduledEvent } from "firebase-functions/v2/scheduler"; // Correct import for ScheduledEvent
import * as logger from "firebase-functions/logger"; // Correct import for v2 logger
import * as admin from "firebase-admin";

admin.initializeApp();

const db = admin.firestore();
const storage = admin.storage();

// Define a type for the order data as used within this function
interface DocumentOrderInFunction {
  fileName: string;
  fileStoragePath?: string;
  isFileDeleted?: boolean;
  uploadedAt?: string; // Used in query
  // Add other fields from DocumentOrder if needed by function logic in future
}


// Scheduled function to run, for example, every day at 3 AM.
export const autoDeleteOldOrderFiles = onSchedule(
  {
    schedule: "every day 03:00",
    timeZone: "Asia/Kolkata",
  },
  async (event: ScheduledEvent) => { // Type the event
    logger.info("Starting autoDeleteOldOrderFiles function run", {
      eventTime: event.scheduleTime, // Corrected from event.time to event.scheduleTime
      configuredSchedule: "every day 03:00",
      configuredTimeZone: "Asia/Kolkata",
    });

    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const fiveDaysAgoISO = fiveDaysAgo.toISOString();

    try {
      const ordersSnapshot = await db
        .collection("orders")
        .where("uploadedAt", "<=", fiveDaysAgoISO)
        .where("fileStoragePath", "!=", null)
        .where("isFileDeleted", "==", false)
        .get();

      if (ordersSnapshot.empty) {
        logger.info("No old order files found to delete.");
        return;
      }

      const storageDeletePromises: Promise<{
        orderId: string;
        filePath: string;
        success: boolean;
        error?: Error;
      }>[] = [];

      ordersSnapshot.forEach((docSnap: admin.firestore.QueryDocumentSnapshot) => { // Type docSnap
        const order = docSnap.data() as DocumentOrderInFunction; // Use defined type

        if (order.fileStoragePath) {
          logger.info(
            `Queueing file for deletion: ${order.fileStoragePath} for order ${docSnap.id}`
          );
          const fileRef = storage.bucket().file(order.fileStoragePath);
          storageDeletePromises.push(
            fileRef
              .delete()
              .then(() => ({
                orderId: docSnap.id,
                filePath: order.fileStoragePath!,
                success: true,
              }))
              .catch((error: Error) => ({ // Type error
                orderId: docSnap.id,
                filePath: order.fileStoragePath!,
                success: false,
                error: error,
              }))
          );
        }
      });

      if (storageDeletePromises.length === 0) {
        logger.info("No files were eligible for deletion attempt in this run after path filtering.");
        return;
      }

      const deletionResults = await Promise.allSettled(storageDeletePromises);

      const batch = db.batch();
      let filesMarkedInFirestoreCount = 0;

      deletionResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          const { orderId, filePath, success, error } = result.value;
          const orderDocRef = db.collection("orders").doc(orderId);

          if (success) {
            logger.info(
              `Successfully deleted file from Storage: ${filePath}. Marking in Firestore for order ${orderId}.`
            );
            batch.update(orderDocRef, { isFileDeleted: true });
            filesMarkedInFirestoreCount++;
          } else {
            logger.error(
              `Failed to delete file from Storage: ${filePath} for order ${orderId}. Marking in Firestore.`,
              error
            );
            batch.update(orderDocRef, { isFileDeleted: true, fileDeletionError: error?.message || String(error) });
            filesMarkedInFirestoreCount++;
          }
        } else {
          logger.error("Unexpected promise rejection in deletionResults processing:", result.reason);
        }
      });

      if (filesMarkedInFirestoreCount > 0) {
        await batch.commit();
        logger.info(
          `Successfully processed and batched Firestore updates for ${filesMarkedInFirestoreCount} orders.`
        );
      } else {
        logger.info("No Firestore updates were made in this run.");
      }

    } catch (error: any) { // Type error
      logger.error("Error in autoDeleteOldOrderFiles function:", error);
      // Consider re-throwing if retries are desired: throw error;
    }
    // Implicitly return undefined (Promise<void>)
    return;
  }
);
