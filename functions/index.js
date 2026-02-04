const { https } = require("firebase-functions/v2");
const { scheduler } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Calculate boss max HP for a given phase
function calculateBossHP(phase) {
  if (phase <= 100) {
    // Exponential growth from 10,000 (phase 1) to 1,000,000,000 (phase 100)
    const baseHP = 10000;
    const multiplier = Math.pow(100000, 1/99); // ≈ 1.1174
    return Math.floor(baseHP * Math.pow(multiplier, phase - 1));
  } else {
    // Linear growth: 1 billion HP per level after phase 100
    return 1000000000 * (phase - 99);
  }
}

// Calculate player's DPS based on upgrade levels
function calculateDPS(upgrades) {
  // Base damage: 1 + (damage level * 2)
  const damageLevel = upgrades.damage || 0;
  const baseDamage = 1 + (damageLevel * 2);

  // Crit chance: level * 2 (as percentage)
  const critChanceLevel = upgrades.critchance || 0;
  const critChance = (critChanceLevel * 2) / 100; // Convert to decimal

  // Crit multiplier: 1.0 + (level * 0.1)
  const critDamageLevel = upgrades.critdamage || 0;
  const critMultiplier = critDamageLevel * 0.1;

  // Average damage per hit = baseDamage * (1 + critMultiplier * critChance)
  const avgDamagePerHit = baseDamage * (1 + critMultiplier * critChance);

  // Attack speed: base 2000ms, reduced by 10% per level
  const attackSpeedLevel = upgrades.attackspeed || 0;
  const attackInterval = 2000 * Math.pow(0.9, attackSpeedLevel);

  // DPS = average damage per hit / (interval in seconds)
  const dps = avgDamagePerHit / (attackInterval / 1000);

  return dps;
}

// Calculate XP earned based on DPS and time elapsed
function calculateXPEarned(dps, timeElapsedMs) {
  // XP = 50% of damage dealt
  const damage = dps * (timeElapsedMs / 1000);
  const xp = damage * 0.5;
  return Math.floor(xp);
}

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
    const { damage, windowStart, windowEnd } = request.data;

    const playerRef = db.collection("players").doc(uid);
    const playerDoc = await playerRef.get();
    if (!playerDoc.exists) throw new https.HttpsError("not-found", "Player not found");

    const player = playerDoc.data();

    // Load player's upgrades to calculate DPS
    const upgradesSnapshot = await playerRef.collection("upgrades").get();
    const upgrades = {};
    upgradesSnapshot.forEach(doc => {
      upgrades[doc.id] = doc.data().level || 0;
    });

    // Calculate DPS from upgrades (server-side, can't be cheated)
    const dps = calculateDPS(upgrades);

    // Calculate XP earned based on DPS and time elapsed
    const timeElapsed = Date.now() - (player.lastDamageSubmit || Date.now());
    const xpEarned = calculateXPEarned(dps, timeElapsed);

    // Calculate damage based on DPS and time elapsed (server authoritative)
    const calculatedDamage = dps * (timeElapsed / 1000);
    const maxAllowedDamage = 100000;
    const appliedDamage = Math.min(calculatedDamage, maxAllowedDamage);

    let bossDied = false;
    const bossRef = db.collection("boss").doc("state");
    await db.runTransaction(async (tx) => {
      const bossDoc = await tx.get(bossRef);
      if (!bossDoc.exists) throw new https.HttpsError("not-found", "Boss not found");

      const boss = bossDoc.data();
      let newHealth = boss.currentHealth - appliedDamage;

      if (newHealth <= 0) {
        // Boss dies → advance to next phase
        const newPhase = boss.phase + 1;
        const newMaxHealth = calculateBossHP(newPhase);
        newHealth = newMaxHealth;
        bossDied = true;

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

      // Update player stats with server-calculated XP
      tx.update(playerRef, {
        lastDamageSubmit: Date.now(),
        totalDamage: (player.totalDamage || 0) + appliedDamage,
        totalXP: (player.totalXP || 0) + xpEarned,
        lastSeen: Date.now()
      });
    });

    // Update online count when boss dies (outside transaction)
    if (bossDied) {
      await updateOnlinePlayerCount();
    }

    return { success: true, appliedDamage, xpEarned, newTotalXP: (player.totalXP || 0) + xpEarned };
  }
);

exports.purchaseUpgrade = https.onCall(
  { region: "australia-southeast1", cors: true },
  async (request) => {
    if (!request.auth) throw new https.HttpsError("unauthenticated", "Login required");

    const uid = request.auth.uid;
    const { upgradeType } = request.data;

    // Upgrade definitions (must match client-side for display)
    const upgradeDefs = {
      damage: { baseCost: 2, costMultiplier: 2.0, maxLevel: null },
      attackspeed: { baseCost: 128, costMultiplier: 2.0, maxLevel: 20 },
      critchance: { baseCost: 2, costMultiplier: 2.0, maxLevel: 30 },
      critdamage: { baseCost: 2, costMultiplier: 2.0, maxLevel: 30 }
    };

    if (!upgradeDefs[upgradeType]) {
      throw new https.HttpsError("invalid-argument", "Invalid upgrade type");
    }

    const playerRef = db.collection("players").doc(uid);
    const upgradeRef = playerRef.collection("upgrades").doc(upgradeType);

    let newTotalXP = 0;

    await db.runTransaction(async (tx) => {
      const playerDoc = await tx.get(playerRef);
      if (!playerDoc.exists) throw new https.HttpsError("not-found", "Player not found");

      const player = playerDoc.data();

      // Load all upgrades to calculate DPS
      const upgradesSnapshot = await playerRef.collection("upgrades").get();
      const upgrades = {};
      upgradesSnapshot.forEach(doc => {
        upgrades[doc.id] = doc.data().level || 0;
      });

      // Calculate XP earned since last damage submit
      const dps = calculateDPS(upgrades);
      const timeElapsed = Date.now() - (player.lastDamageSubmit || Date.now());
      const xpEarned = calculateXPEarned(dps, timeElapsed);

      // Update player's totalXP with earned XP
      let currentTotalXP = (player.totalXP || 0) + xpEarned;

      // Get current upgrade level
      const upgradeDoc = await tx.get(upgradeRef);
      const currentLevel = upgradeDoc.exists ? (upgradeDoc.data().level || 0) : 0;

      // Check if upgrade is at max level
      const upgradeDef = upgradeDefs[upgradeType];
      if (upgradeDef.maxLevel && currentLevel >= upgradeDef.maxLevel) {
        throw new https.HttpsError("failed-precondition", `Upgrade is already at max level (${upgradeDef.maxLevel})`);
      }

      // Calculate cost (server-side, can't be cheated)
      const cost = Math.floor(upgradeDef.baseCost * Math.pow(upgradeDef.costMultiplier, currentLevel));

      // Verify player has enough XP
      if (currentTotalXP < cost) {
        throw new https.HttpsError("failed-precondition", `Not enough Total XP. Need ${cost}, have ${currentTotalXP}`);
      }

      // Deduct XP and update upgrade level
      newTotalXP = currentTotalXP - cost;
      tx.update(playerRef, {
        totalXP: newTotalXP,
        lastDamageSubmit: Date.now(), // Reset the timer after calculating earned XP
        lastSeen: Date.now()
      });

      tx.set(upgradeRef, {
        level: currentLevel + 1
      });
    });

    return { success: true, newTotalXP };
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

// Helper function to update online player count
async function updateOnlinePlayerCount() {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

  // Query players who have been seen in the last 5 minutes
  const onlinePlayersSnapshot = await db.collection("players")
    .where("lastSeen", ">=", fiveMinutesAgo)
    .get();

  const onlineCount = onlinePlayersSnapshot.size;

  // Update the stats/online document
  await db.collection("stats").doc("online").set({
    count: onlineCount,
    lastUpdated: Date.now()
  });

  console.log(`Online count updated: ${onlineCount} players`);
  return onlineCount;
}

// Scheduled function to update online player count every 5 minutes
exports.updateOnlineCount = scheduler.onSchedule(
  {
    schedule: "every 5 minutes",
    region: "australia-southeast1",
    timeZone: "Australia/Sydney"
  },
  async (event) => {
    await updateOnlinePlayerCount();
  }
);
