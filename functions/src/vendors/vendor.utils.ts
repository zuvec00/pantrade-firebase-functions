import {onSchedule} from "firebase-functions/scheduler";
import {admin, db} from "../firebase";

export const updateViewCounts = onSchedule({
  schedule: "every 30 minutes",
  enforceAppCheck: true,
}, async (context) => {
  try {
    const oneHourAgo = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - 3600000) // 1 hour in milliseconds
    );

    const vendorsSnapshot = await db.collection("vendors").listDocuments();
    const batch = db.batch();
    let processedCount = 0;

    for (const vendorDoc of vendorsSnapshot) {
      const viewsSnapshot = await db
        .collection("vendorViews")
        .doc(vendorDoc.id)
        .collection("viewEvents")
        .where("timestamp", ">", oneHourAgo)
        .count()
        .get();

      batch.update(vendorDoc, {
        lastHourViews: viewsSnapshot.data().count,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });

      processedCount++;
    }

    await batch.commit();
    console.log(`Successfully updated view counts for ${processedCount} vendors`);
  } catch (error) {
    console.error("Error updating vendor view counts:", error);
    // Don't throw the error as this is a scheduled function
  }
});
