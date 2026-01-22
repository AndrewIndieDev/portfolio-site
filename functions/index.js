const { https } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// CORS configuration
const corsOptions = {
  cors: true, // Allow all origins in development
};

exports.createPlayer = https.onCall(
  { region: "australia-southeast1", cors: true },
  async (request) => {
    // In Functions v2, auth is in request.auth, not context.auth
    if (!request.auth) throw new https.HttpsError("unauthenticated", "Login required");

    const uid = request.auth.uid;
    const playerRef = db.collection("players").doc(uid);
    const doc = await playerRef.get();

    if (!doc.exists) {
      await playerRef.set({
        totalXP: 0,
        lastSeen: Date.now(),
        lastDamageSubmit: Date.now(),
        totalDamage: 0
      });
    }

    return { success: true };
  }
);

exports.submitDamage = https.onCall(
  { region: "australia-southeast1", cors: true },
  async (request) => {
    // In Functions v2, auth is in request.auth, data is in request.data
    if (!request.auth) throw new https.HttpsError("unauthenticated", "Login required");

    const uid = request.auth.uid;
    const { damage, windowStart, windowEnd, totalXPGained } = request.data;

    const playerRef = db.collection("players").doc(uid);
    const playerDoc = await playerRef.get();
    if (!playerDoc.exists) throw new https.HttpsError("not-found", "Player not found");

    const player = playerDoc.data();
    const maxAllowedDamage = 100000;

    const appliedDamage = Math.min(damage, maxAllowedDamage);

    const bossRef = db.collection("boss").doc("state");
    await db.runTransaction(async (tx) => {
      const bossDoc = await tx.get(bossRef);
      if (!bossDoc.exists) throw new https.HttpsError("not-found", "Boss not found");

      const boss = bossDoc.data();
      let newHealth = boss.currentHealth - appliedDamage;

      if (newHealth <= 0) {
        // Boss dies → reset phase
        const newPhase = boss.phase + 1;
        const newMaxHealth = boss.baseHealth * (1 + newPhase * 0.5); // scale up
        newHealth = newMaxHealth;

        tx.update(bossRef, {
          currentHealth: newHealth,
          maxHealth: newMaxHealth,
          phase: newPhase,
          deathCount: boss.deathCount + 1,
          lastUpdate: Date.now()
        });
      } else {
        // just reduce health
        tx.update(bossRef, {
          currentHealth: newHealth,
          lastUpdate: Date.now()
        });
      }

      // Update player stats including totalXP gained from hits
      tx.update(playerRef, {
        lastDamageSubmit: Date.now(),
        totalDamage: (player.totalDamage || 0) + appliedDamage,
        totalXP: (player.totalXP || 0) + (totalXPGained || 0),
        lastSeen: Date.now()
      });
    });

    return { success: true, appliedDamage };
  }
);

exports.purchaseUpgrade = https.onCall(
  { region: "australia-southeast1", cors: true },
  async (request) => {
    if (!request.auth) throw new https.HttpsError("unauthenticated", "Login required");

    const uid = request.auth.uid;
    const { upgradeType, cost } = request.data;

    const playerRef = db.collection("players").doc(uid);
    const upgradeRef = playerRef.collection("upgrades").doc(upgradeType);

    await db.runTransaction(async (tx) => {
      const playerDoc = await tx.get(playerRef);
      if (!playerDoc.exists) throw new https.HttpsError("not-found", "Player not found");

      const player = playerDoc.data();
      const currentTotalXP = player.totalXP || 0;

      // Verify player has enough XP
      if (currentTotalXP < cost) {
        throw new https.HttpsError("failed-precondition", "Not enough Total XP");
      }

      // Get current upgrade level
      const upgradeDoc = await tx.get(upgradeRef);
      const currentLevel = upgradeDoc.exists ? (upgradeDoc.data().level || 0) : 0;

      // Deduct XP and update upgrade level
      tx.update(playerRef, {
        totalXP: currentTotalXP - cost,
        lastSeen: Date.now()
      });

      tx.set(upgradeRef, {
        level: currentLevel + 1
      });
    });

    return { success: true };
  }
);

exports.grantAchievementXP = https.onCall(
  { region: "australia-southeast1", cors: true },
  async (request) => {
    if (!request.auth) throw new https.HttpsError("unauthenticated", "Login required");

    const uid = request.auth.uid;
    const { xpAmount } = request.data;

    // Validate XP amount (reasonable range for achievement XP)
    if (!xpAmount || xpAmount < 0 || xpAmount > 100) {
      throw new https.HttpsError("invalid-argument", "Invalid XP amount");
    }

    const playerRef = db.collection("players").doc(uid);

    await db.runTransaction(async (tx) => {
      const playerDoc = await tx.get(playerRef);
      if (!playerDoc.exists) throw new https.HttpsError("not-found", "Player not found");

      const player = playerDoc.data();
      const currentTotalXP = player.totalXP || 0;

      tx.update(playerRef, {
        totalXP: currentTotalXP + xpAmount,
        lastSeen: Date.now()
      });
    });

    return { success: true, newTotalXP: (await playerRef.get()).data().totalXP };
  }
);
