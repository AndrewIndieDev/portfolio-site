const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const fs = require("node:fs/promises");
const path = require("node:path");

admin.initializeApp();
const db = admin.firestore();

const REGION = "australia-southeast1";
const STORE_RATINGS_COLLECTION = "storeRatings";
const STORE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const BROWSER_CACHE_SECONDS = 10 * 60;
const SITE_CONTENT_URL = "https://andrewdowsett.dev/data/site-content.json";
const SITE_CONTENT_CACHE_MS = 5 * 60 * 1000;
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/andrewdowsett\.dev$/i,
  /^https:\/\/www\.andrewdowsett\.dev$/i,
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i
];

let cachedCanonicalSources = {
  loadedAt: 0,
  sources: []
};

function now() {
  return Date.now();
}

function isAllowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function applyCorsHeaders(request, response) {
  const origin = request.get("origin");
  if (!isAllowedOrigin(origin)) {
    return false;
  }

  response.set("Access-Control-Allow-Origin", origin);
  response.set("Vary", "Origin");
  response.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type");
  return true;
}

function encodeStoreKey(key) {
  return Buffer.from(key).toString("base64url");
}

function parseSteamAppId(url) {
  if (typeof url !== "string") {
    return null;
  }

  const match = url.match(/store\.steampowered\.com\/app\/(\d+)/i);
  return match ? match[1] : null;
}

function normalizeItchUrl(url) {
  if (typeof url !== "string") {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (!/\.itch\.io$/i.test(parsed.hostname)) {
    return null;
  }

  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (!pathParts.length) {
    return null;
  }

  return `https://${parsed.hostname}/${pathParts[0]}`;
}

function normalizeStoreSources(payload) {
  const projects = Array.isArray(payload?.projects) ? payload.projects : [];
  const keyed = new Map();

  for (const project of projects) {
    const projectId = typeof project?.id === "string" ? project.id : null;
    const links = Array.isArray(project?.links) ? project.links : [];

    for (const link of links) {
      const url = typeof link?.url === "string" ? link.url : "";
      const steamAppId = parseSteamAppId(url);

      if (steamAppId) {
        const key = `steam:${steamAppId}`;
        const existing = keyed.get(key);
        if (existing) {
          if (projectId) {
            existing.projectIds.push(projectId);
          }
        } else {
          keyed.set(key, {
            key,
            type: "steam",
            appId: steamAppId,
            url,
            projectIds: projectId ? [projectId] : []
          });
        }
        continue;
      }

      const itchUrl = normalizeItchUrl(url);
      if (!itchUrl) {
        continue;
      }

      const key = `itch:${itchUrl}`;
      const existing = keyed.get(key);
      if (existing) {
        if (projectId) {
          existing.projectIds.push(projectId);
        }
      } else {
        keyed.set(key, {
          key,
          type: "itch",
          url: itchUrl,
          projectIds: projectId ? [projectId] : []
        });
      }
    }
  }

  return [...keyed.values()].map((source) => ({
    ...source,
    projectIds: [...new Set(source.projectIds)]
  }));
}

async function loadSiteContentFromFile() {
  const localPath = path.resolve(__dirname, "..", "data", "site-content.json");
  const raw = await fs.readFile(localPath, "utf8");
  return JSON.parse(raw);
}

async function getCanonicalStoreSources() {
  const currentTime = now();
  if (cachedCanonicalSources.sources.length && (currentTime - cachedCanonicalSources.loadedAt) < SITE_CONTENT_CACHE_MS) {
    return cachedCanonicalSources.sources;
  }

  let content;
  try {
    const response = await fetch(SITE_CONTENT_URL, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Site content request failed with ${response.status}`);
    }
    content = await response.json();
  } catch (error) {
    content = await loadSiteContentFromFile();
  }

  const sources = normalizeStoreSources({ projects: content?.projects });
  cachedCanonicalSources = {
    loadedAt: currentTime,
    sources
  };

  return sources;
}

async function fetchSteamRating(source) {
  const response = await fetch(`https://store.steampowered.com/appreviews/${source.appId}?json=1&filter=summary&language=all&purchase_type=all&num_per_page=0`);
  if (!response.ok) {
    throw new Error(`Steam request failed with ${response.status}`);
  }

  const payload = await response.json();
  const summary = payload?.query_summary;
  if (!payload?.success || !summary) {
    throw new Error("Steam summary payload missing");
  }

  const totalPositive = Number(summary.total_positive ?? 0);
  const totalNegative = Number(summary.total_negative ?? 0);
  const totalReviews = Number(summary.total_reviews ?? (totalPositive + totalNegative));
  const percent = totalReviews > 0 ? Math.floor((totalPositive / totalReviews) * 100) : 0;

  if (!Number.isFinite(percent) || !Number.isFinite(totalReviews) || totalReviews <= 0) {
    return {
      status: "unavailable",
      label: "Steam Reviews",
      valueText: "Unavailable",
      count: 0,
      score: null
    };
  }

  const descriptor = String(summary.review_score_desc || "User Reviews").trim();
  return {
    status: "ok",
    label: "Steam Reviews",
    valueText: `${percent}% ${descriptor} (${totalReviews})`,
    count: totalReviews,
    score: percent
  };
}

async function fetchItchRating(source) {
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`itch request failed with ${response.status}`);
  }

  const html = await response.text();
  const ratingMatch =
    html.match(/itemprop="ratingValue"[^>]*content="([0-9.]+)"/i) ||
    html.match(/"aggregateRating"\s*:\s*\{.*?"ratingValue"\s*:\s*"?([0-9.]+)"?/is) ||
    html.match(/Rated\s+([0-9.]+)\s+out of 5 stars/i);

  const countMatch =
    html.match(/itemprop="ratingCount"[^>]*content="([0-9,]+)"/i) ||
    html.match(/"aggregateRating"\s*:\s*\{.*?"ratingCount"\s*:\s*([0-9,]+)/is) ||
    html.match(/\(([0-9,]+)\s+total ratings\)/i);

  if (!ratingMatch || !countMatch) {
    return {
      status: "unrated",
      label: "itch.io Rating",
      valueText: "No public rating",
      count: 0,
      score: null
    };
  }

  const rating = Number(ratingMatch[1]);
  const totalRatings = Number(countMatch[1].replaceAll(",", ""));

  return {
    status: "ok",
    label: "itch.io Rating",
    valueText: `${rating.toFixed(1)}/5 (${totalRatings})`,
    count: totalRatings,
    score: rating
  };
}

async function fetchStoreRating(source) {
  if (source.type === "steam") {
    return fetchSteamRating(source);
  }

  if (source.type === "itch") {
    return fetchItchRating(source);
  }

  throw new Error(`Unsupported source type: ${source.type}`);
}

async function refreshStoreRating(source, existing = {}) {
  const key = source.key || existing.key;
  const docRef = db.collection(STORE_RATINGS_COLLECTION).doc(encodeStoreKey(key));
  const refreshedAt = now();

  try {
    const latest = await fetchStoreRating(source);
    const payload = {
      key,
      type: source.type,
      appId: source.appId || null,
      url: source.url || null,
      label: latest.label,
      valueText: latest.valueText,
      status: latest.status,
      count: latest.count,
      score: latest.score,
      projectIds: source.projectIds || existing.projectIds || [],
      lastRefreshed: refreshedAt,
      lastSeenAt: existing.lastSeenAt || refreshedAt,
      updatedAt: refreshedAt,
      error: admin.firestore.FieldValue.delete()
    };

    await docRef.set(payload, { merge: true });
    return payload;
  } catch (error) {
    const payload = {
      key,
      type: source.type,
      appId: source.appId || null,
      url: source.url || null,
      label: source.type === "steam" ? "Steam Reviews" : "itch.io Rating",
      valueText: "Unavailable",
      status: "unavailable",
      count: 0,
      score: null,
      projectIds: source.projectIds || existing.projectIds || [],
      lastRefreshed: refreshedAt,
      lastSeenAt: existing.lastSeenAt || refreshedAt,
      updatedAt: refreshedAt,
      error: String(error.message || error)
    };

    await docRef.set(payload, { merge: true });
    return payload;
  }
}

async function upsertStoreSources(sources) {
  const snapshots = await Promise.all(
    sources.map((source) => db.collection(STORE_RATINGS_COLLECTION).doc(encodeStoreKey(source.key)).get())
  );

  const results = [];

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    const snapshot = snapshots[i];
    const seenAt = now();
    const existing = snapshot.exists ? snapshot.data() : null;

    if (!existing) {
      results.push(await refreshStoreRating(source, { projectIds: source.projectIds, lastSeenAt: seenAt }));
      continue;
    }

    const projectIds = [...new Set([...(existing.projectIds || []), ...(source.projectIds || [])])];
    await snapshot.ref.set({
      projectIds,
      lastSeenAt: seenAt,
      updatedAt: seenAt
    }, { merge: true });

    if (
      existing.status !== "ok" ||
      !existing.lastRefreshed ||
      (seenAt - existing.lastRefreshed) >= STORE_REFRESH_INTERVAL_MS
    ) {
      results.push(await refreshStoreRating({ ...existing, ...source, projectIds }, { ...existing, projectIds, lastSeenAt: seenAt }));
      continue;
    }

    results.push({
      ...existing,
      key: source.key,
      type: source.type,
      appId: source.appId || existing.appId || null,
      url: source.url || existing.url || null,
      projectIds,
      lastSeenAt: seenAt,
      updatedAt: seenAt
    });
  }

  return results;
}

async function pruneUnknownStoreSources(allowedSources) {
  const allowedKeys = new Set(allowedSources.map((source) => source.key));
  const snapshot = await db.collection(STORE_RATINGS_COLLECTION).get();

  const deletions = snapshot.docs
    .filter((doc) => !allowedKeys.has(doc.data()?.key))
    .map((doc) => doc.ref.delete());

  if (deletions.length) {
    await Promise.all(deletions);
  }
}

exports.getStoreRatings = onRequest(
  { region: REGION, cors: false },
  async (request, response) => {
    if (request.method === "OPTIONS") {
      if (!applyCorsHeaders(request, response)) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      response.status(204).send("");
      return;
    }

    if (!applyCorsHeaders(request, response)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    if (request.method !== "GET") {
      response.status(405).json({ error: "Method not allowed" });
      return;
    }

    const sources = await getCanonicalStoreSources();
    const ratings = await upsertStoreSources(sources);

    response.set("Cache-Control", `public, max-age=${BROWSER_CACHE_SECONDS}`);
    response.json({
      ratings: ratings.map((rating) => ({
        key: rating.key,
        type: rating.type,
        appId: rating.appId || null,
        url: rating.url || null,
        label: rating.label,
        valueText: rating.valueText,
        status: rating.status,
        count: rating.count || 0,
        score: rating.score ?? null,
        projectIds: rating.projectIds || [],
        lastRefreshed: rating.lastRefreshed || null
      }))
    });
  }
);

exports.refreshStoreRatings = onSchedule(
  {
    schedule: "every 60 minutes",
    region: REGION,
    timeZone: "Australia/Sydney"
  },
  async () => {
    const sources = await getCanonicalStoreSources();
    await pruneUnknownStoreSources(sources);

    const snapshots = await Promise.all(
      sources.map((source) => db.collection(STORE_RATINGS_COLLECTION).doc(encodeStoreKey(source.key)).get())
    );

    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      const snapshot = snapshots[i];
      const existing = snapshot.exists ? snapshot.data() : {};

      await refreshStoreRating(
        {
          ...source,
          projectIds: source.projectIds || existing.projectIds || []
        },
        existing
      );
    }
  }
);
