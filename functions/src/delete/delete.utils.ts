import * as functions from "firebase-functions/v2/https";
import {admin, db} from "../firebase";

const storage = admin.storage();
const auth = admin.auth();

// Shared Helper Functions

/**
 * Deletes a Firestore collection (optionally filtered by field/value)
 * @param {FirebaseFirestore.Firestore} db Firestore instance
 * @param {string} collectionPath Path to collection
 * @param {string} [field] Optional field to filter by
 * @param {string} [value] Optional value to match
 */
async function deleteCollection(
  db: FirebaseFirestore.Firestore,
  collectionPath: string,
  field?: string,
  value?: string
) {
  let query: FirebaseFirestore.Query;
  if (field && value) {
    query = db.collection(collectionPath).where(field, "==", value);
  } else {
    query = db.collection(collectionPath);
  }

  const snapshot = await query.get();
  if (snapshot.empty) return;


  // Firestore batch limit is 500
  const batch = db.batch();
  snapshot.docs.slice(0, 500).forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();

  // Recursively delete if we have more items
  if (snapshot.size > 500) {
    return deleteCollection(db, collectionPath, field, value);
  }
}

/**
 * Deletes a subcollection under a specific document.
 * @param {string} parentDocPath Path to parent document (e.g., 'vendors/{vendorId}')
 * @param {string} subcollectionName Name of the subcollection to delete (e.g., 'reviews')
 */
async function deleteSubcollection(
  parentDocPath: string,
  subcollectionName: string
) {
  const snapshot = await db.collection(`${parentDocPath}/${subcollectionName}`).get();

  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });

  await batch.commit();
}
/**
 * Removes a vendor from all user carts
 * @param {string} vendorId Vendor document ID
 */
async function removeVendorFromAllCarts(vendorId: string) {
  const cartsSnapshot = await db.collection("carts").get();

  for (const cartDoc of cartsSnapshot.docs) {
    const cartData = cartDoc.data();
    const vendorIds = cartData.vendorIds as string[] || [];

    if (vendorIds.includes(vendorId)) {
      const batch = db.batch();

      // Remove vendorId from vendorIds array
      batch.update(cartDoc.ref, {
        vendorIds: vendorIds.filter((id) => id !== vendorId),
      });

      // Delete the vendor"s subcollection in the user"s cart
      const vendorSubcollectionRef = cartDoc.ref.collection(vendorId);
      const vendorItemsSnapshot = await vendorSubcollectionRef.get();
      vendorItemsSnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
    }
  }
}
/**
 * Removes a vendor from all user wishlists
 * @param {string} vendorId Vendor document ID
 */
async function removeVendorFromAllWishlists(vendorId: string) {
  const wishlistsSnapshot = await db.collection("wishlists").get();

  for (const wishlistDoc of wishlistsSnapshot.docs) {
    const userId = wishlistDoc.id;

    const userWishlistSnapshot = await db
      .collection("wishlists")
      .doc(userId)
      .collection("userWishlists")
      .where("vendorId", "==", vendorId)
      .get();

    if (!userWishlistSnapshot.empty) {
      const batch = db.batch();
      userWishlistSnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
    }
  }
}

/**
 * Deletes all files in a storage folder
 * @param {admin.storage.Storage} storage Storage instance
 * @param {string} folderPath Path to folder to delete
 */
async function deleteFolder(
  storage: admin.storage.Storage,
  folderPath: string
) {
  try {
    await storage.bucket().deleteFiles({
      prefix: folderPath,
      force: true,
    });
  } catch (error) {
    console.error(`Error deleting folder ${folderPath}:`, error);
    // Continue even if storage deletion fails
  }
}

// Main Cloud Functions
/**
 * Deletes a vendor account and all associated data
 * @param {Object} request Cloud Function request
 * @param {string} request.data.vendorId Vendor document ID
 * @param {string} request.data.userId Auth user ID
 * @throws {functions.https.HttpsError} On validation or deletion failure
 */
export const deleteVendorAccount = functions.onCall(
  {enforceAppCheck: true},
  async (request) => {
    const {vendorId, userId} = request.data;
    console.log("Delete Vendor Account Request:", request.data);

    if (!vendorId || !userId) {
      throw new functions.HttpsError(
        "invalid-argument",
        "Vendor ID and User ID required"
      );
    }

    try {
      // Verify vendor exists and has no funds
      const vendorDoc = await db.collection("users").doc(vendorId).get();
      if (!vendorDoc.exists) {
        throw new functions.HttpsError("not-found", "Vendor not found");
      }

      const vendorData = vendorDoc.data();
      const wallet = vendorData?.wallet || {};
      const eligibleBalance = wallet.eligibleBalance || 0;
      const pendingBalance = wallet.pendingBalance || 0;

      if (eligibleBalance > 0 || pendingBalance > 0) {
        throw new functions.HttpsError(
          "failed-precondition",
          "Withdraw your funds before deleting your account"
        );
      }

      // Delete vendor-related data
      await Promise.all([
        deleteCollection(db, "products", "vendorId", vendorId),
        deleteCollection(db, "packaging", "vendorId", vendorId),
        deleteCollection(db, "optionItems", "vendorId", vendorId),
        deleteCollection(db, "optionGroups", "vendorId", vendorId),
        deleteCollection(db, "categories", "vendorId", vendorId),
      ]);

      // Delete remaining documents
      const batch = db.batch();
      batch.delete(db.collection("vendors").doc(vendorId));
      batch.delete(db.collection("users").doc(userId));
      await removeVendorFromAllCarts(vendorId);
      await removeVendorFromAllWishlists(vendorId);
      await deleteSubcollection(`vendors/${vendorId}`, "reviews");
      await deleteSubcollection(`users/${userId}`, "security");
      await batch.commit();

      // Delete storage
      await Promise.all([
        deleteFolder(storage, `vendors/${vendorId}/`),
        deleteFolder(storage, `products/${vendorId}/`),
      ]);

      // Delete auth record last
      await auth.deleteUser(userId);

      return {success: true};
    } catch (error: any) {
      console.error("Delete Vendor Error:", error);
      if (error instanceof functions.HttpsError) throw error;
      throw new functions.HttpsError("internal", error.message || "Deletion failed");
    }
  }
);

/**
 * Deletes a regular user account and associated data
 * @param {Object} request Cloud Function request
 * @param {string} request.data.userId User ID to delete
 * @throws {functions.https.HttpsError} On validation or deletion failure
 */
export const deleteUserAccount = functions.onCall(
  {enforceAppCheck: true},
  async (request) => {
    const {userId} = request.data;

    if (!userId) {
      throw new functions.HttpsError("invalid-argument", "User ID required");
    }

    try {
      // Verify user exists
      const userDoc = await db.collection("users").doc(userId).get();
      if (!userDoc.exists) {
        throw new functions.HttpsError("not-found", "User not found");
      }

      // Check for account restrictions
      const userData = userDoc.data();
      if (userData?.role === "vendor") {
        throw new functions.HttpsError(
          "failed-precondition",
          "Vendors must use the vendor deletion process"
        );
      }

      // FIRST: Delete cart subcollections
      const cartDocRef = db.collection("carts").doc(userId);
      const cartSubcollections = await cartDocRef.listCollections();
      for (const vendorSubCol of cartSubcollections) {
        const vendorCartItems = await vendorSubCol.get();
        const batch = db.batch();
        vendorCartItems.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }

      // THEN: Delete wishlist subcollection
      const wishlistDocRef = db.collection("wishlists").doc(userId);
      const wishlistSubcollection = await wishlistDocRef.collection("userWishlists").get();
      if (!wishlistSubcollection.empty) {
        const batch = db.batch();
        wishlistSubcollection.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
      }

      // FINALLY: Delete parent docs
      const batch = db.batch();
      batch.delete(db.collection("users").doc(userId));
      batch.delete(db.collection("carts").doc(userId));
      batch.delete(db.collection("wishlists").doc(userId));
      await batch.commit();

      // Delete storage
      await deleteFolder(storage, `users/${userId}/`);

      // Delete auth record
      await auth.deleteUser(userId);

      return {success: true};
    } catch (error: any) {
      console.error("Delete User Error:", error);
      if (error instanceof functions.HttpsError) throw error;
      throw new functions.HttpsError("internal", error.message || "Deletion failed");
    }
  }
);
