const dom = {
  appShell: document.getElementById("app"),
  mobileMenuToggle: document.getElementById("mobileMenuToggle"),
  mobileNavScrim: document.getElementById("mobileNavScrim"),
  navRail: document.getElementById("navRail"),
  contentViewport: document.getElementById("contentViewport")
};

const STORE_RATINGS_ENDPOINT = "https://australia-southeast1-portfolio-boss-raid.cloudfunctions.net/getStoreRatings";

const appState = {
  content: null,
  ui: {
    projectsExpanded: false,
    activeTarget: "about",
    mobileNavOpen: false
  },
  steamReviews: new Map(),
  itchRatings: new Map(),
  mediaObserver: null,
  floorData: new Map(),
  sectionElements: new Map(),
  navElements: new Map(),
  queueElements: new Map(),
  citizenElements: new Map(),
  citizens: [],
  elevator: {
    animationFrame: null,
    stops: [],
    currentStopIndex: 0,
    direction: 1,
    holdMs: 950,
    travelMs: 1650,
    phase: "hold",
    phaseStartedAt: 0,
    lastArrivedKey: null
  }
};

const ELEVATOR_CAPACITY = 12;
const CITIZEN_COUNT = 100;
const CITIZEN_WIDTH = 8;
const CITIZEN_HEIGHT = 10;
const CITIZEN_SPEED_PX_PER_MS = 0.035;

function renderQueueLine(sectionKey) {
  return `
    <div class="section-queue" data-queue-line="${escapeHtml(sectionKey)}" aria-hidden="true">
      <div class="section-queue__slots">
        <span class="section-queue__slot"></span>
        <span class="section-queue__slot"></span>
        <span class="section-queue__slot"></span>
        <span class="section-queue__slot"></span>
        <span class="section-queue__slot"></span>
        <span class="section-queue__slot"></span>
        <span class="section-queue__slot"></span>
        <span class="section-queue__slot"></span>
      </div>
    </div>
  `;
}

async function loadContent() {
  const response = await fetch("data/site-content.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Failed to load site content.");
  }
  return response.json();
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function extractSteamAppId(project) {
  const steamLink = project.links.find((link) => /store\.steampowered\.com\/app\/(\d+)/i.test(link.url));
  if (!steamLink) {
    return null;
  }

  const match = steamLink.url.match(/store\.steampowered\.com\/app\/(\d+)/i);
  return match ? match[1] : null;
}

function extractItchUrl(project) {
  const itchLink = project.links.find((link) => /https?:\/\/[^\s]+\.itch\.io\/[^\s/]+/i.test(link.url));
  return itchLink ? itchLink.url : null;
}

function formatReviewPercent(reviewSummary) {
  if (typeof reviewSummary.review_score !== "number") {
    return null;
  }

  if (reviewSummary.review_score <= 1) {
    return `${Math.round(reviewSummary.review_score * 100)}%`;
  }

  return `${Math.round(reviewSummary.review_score)}%`;
}

function renderSteamReviewBadge(project) {
  const appId = extractSteamAppId(project);
  if (!appId) {
    return "";
  }

  return `
    <div class="steam-review-badge" data-steam-app-id="${escapeHtml(appId)}" aria-live="polite">
      <span class="steam-review-label">Steam Reviews</span>
      <span class="steam-review-value">Loading...</span>
    </div>
  `;
}

function renderItchRatingBadge(project) {
  const itchUrl = extractItchUrl(project);
  if (!itchUrl) {
    return "";
  }

  return `
    <div class="store-rating-badge" data-itch-url="${escapeHtml(itchUrl)}" aria-live="polite">
      <span class="store-rating-label">itch.io Rating</span>
      <span class="store-rating-value">Loading...</span>
    </div>
  `;
}

function getStoreRatingsPayload() {
  return {
    projects: appState.content.projects.map((project) => ({
      id: project.id,
      links: project.links.map((link) => ({
        url: link.url
      }))
    }))
  };
}

function applySteamReviewBadges() {
  dom.contentViewport.querySelectorAll("[data-steam-app-id]").forEach((badge) => {
    const appId = badge.dataset.steamAppId;
    const summary = appState.steamReviews.get(appId);
    const value = badge.querySelector(".steam-review-value");

    if (!value || !summary) {
      return;
    }

    if (summary.error) {
      value.textContent = "Unavailable";
      badge.classList.add("is-unavailable");
      return;
    }

    value.textContent = summary.valueText;
    badge.classList.add("is-loaded");
  });
}

function applyItchRatingBadges() {
  dom.contentViewport.querySelectorAll("[data-itch-url]").forEach((badge) => {
    const itchUrl = badge.dataset.itchUrl;
    const summary = appState.itchRatings.get(itchUrl);
    const value = badge.querySelector(".store-rating-value");

    if (!value || !summary) {
      return;
    }

    if (summary.error) {
      value.textContent = "Unavailable";
      badge.classList.add("is-unavailable");
      return;
    }

    if (summary.status === "unrated") {
      value.textContent = "No public rating";
      badge.classList.add("is-unavailable");
      return;
    }

    value.textContent = summary.valueText;
    badge.classList.add("is-loaded");
  });
}

function markStoreRatingsUnavailable() {
  dom.contentViewport.querySelectorAll("[data-steam-app-id]").forEach((badge) => {
    const value = badge.querySelector(".steam-review-value");
    if (value) {
      value.textContent = "Unavailable";
      badge.classList.add("is-unavailable");
    }
  });

  dom.contentViewport.querySelectorAll("[data-itch-url]").forEach((badge) => {
    const value = badge.querySelector(".store-rating-value");
    if (value) {
      value.textContent = "Unavailable";
      badge.classList.add("is-unavailable");
    }
  });
}

async function loadStoreRatings() {
  const response = await fetch(STORE_RATINGS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    cache: "default",
    body: JSON.stringify(getStoreRatingsPayload())
  });

  if (!response.ok) {
    throw new Error("Failed to load cached store ratings.");
  }

  const payload = await response.json();
  const ratings = Array.isArray(payload?.ratings) ? payload.ratings : [];

  appState.steamReviews.clear();
  appState.itchRatings.clear();

  ratings.forEach((rating) => {
    if (rating.type === "steam" && rating.appId) {
      appState.steamReviews.set(rating.appId, rating);
    }

    if (rating.type === "itch" && rating.url) {
      appState.itchRatings.set(rating.url, rating);
    }
  });

  dom.contentViewport.querySelectorAll("[data-steam-app-id]").forEach((badge) => {
    const appId = badge.dataset.steamAppId;
    if (!appState.steamReviews.has(appId)) {
      appState.steamReviews.set(appId, { error: true });
    }
  });

  dom.contentViewport.querySelectorAll("[data-itch-url]").forEach((badge) => {
    const itchUrl = badge.dataset.itchUrl;
    if (!appState.itchRatings.has(itchUrl)) {
      appState.itchRatings.set(itchUrl, { error: true });
    }
  });

  applyItchRatingBadges();
  applySteamReviewBadges();
}

function renderNav() {
  const { site, sections, projects } = appState.content;
  const navUtilityLinks = sections.contact.links
    .map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`)
    .join("");

  dom.navRail.innerHTML = `
    <div class="nav-header">
      <h1 class="nav-title">${escapeHtml(site.title)}</h1>
      <div class="nav-role">${escapeHtml(site.role)}</div>
      <div class="nav-intro">${escapeHtml(site.intro)}</div>
    </div>
    <div class="nav-list">
      <button class="nav-button" data-target="about">About</button>
      <button class="nav-button" data-target="skills">Skills</button>
      <button class="nav-button" data-target="experience">Experience</button>
      <div class="nav-section">
        <button class="nav-group-toggle" data-group-toggle="projects">
          <span>Projects</span>
          <span>${appState.ui.projectsExpanded ? "-" : "+"}</span>
        </button>
        <div class="nav-project-list${appState.ui.projectsExpanded ? " is-expanded" : ""}">
          ${projects.map((project) => `<button class="nav-project-button" data-target="project-${project.id}">${escapeHtml(project.label)}</button>`).join("")}
        </div>
      </div>
      <button class="nav-button" data-target="contact">Contact</button>
    </div>
    <div class="nav-utility">
      ${navUtilityLinks}
    </div>
  `;

  appState.navElements.clear();
  dom.navRail.querySelectorAll("[data-target]").forEach((element) => {
    appState.navElements.set(element.dataset.target, element);
    element.addEventListener("click", () => {
      scrollToTarget(element.dataset.target);
      if (window.matchMedia("(max-width: 900px)").matches) {
        setMobileNavOpen(false);
      }
    });
  });

  dom.navRail.querySelector("[data-group-toggle='projects']")?.addEventListener("click", () => {
    appState.ui.projectsExpanded = !appState.ui.projectsExpanded;
    renderNav();
    updateActiveNav();
  });
}

function renderContent() {
  const { site, sections, projects } = appState.content;

  dom.contentViewport.innerHTML = `
    <div class="content-scene">
      <div class="scroll-elevator" aria-hidden="true">
        <div class="scroll-elevator__shaft"></div>
        <div class="scroll-elevator__track"></div>
        <div class="scroll-elevator__car">
          <div class="scroll-elevator__display">ABOUT</div>
          <div class="scroll-elevator__slots">
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
            <span class="scroll-elevator__slot"></span>
          </div>
        </div>
      </div>
      <div class="citizen-layer" aria-hidden="true"></div>
      <div class="content-stack">
      <section class="hero-panel" data-section="hero">
        <h2 class="hero-title">${escapeHtml(site.title)}</h2>
        <div class="hero-copy">${escapeHtml(site.intro)}</div>
      </section>

      <section class="section-panel" id="about" data-section="about">
        ${renderQueueLine("about")}
        <div class="section-header">
          <h2 class="section-title">${escapeHtml(sections.about.label)}</h2>
          <div class="section-kicker">Overview</div>
        </div>
        <div class="about-body">
          <p class="section-summary">${escapeHtml(sections.about.summary)}</p>
          <div class="section-body">
            ${sections.about.body.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")}
          </div>
        </div>
      </section>

      <section class="section-panel" id="skills" data-section="skills">
        ${renderQueueLine("skills")}
        <div class="section-header">
          <h2 class="section-title">${escapeHtml(sections.skills.label)}</h2>
          <div class="section-kicker">Capabilities</div>
        </div>
        <div class="skills-grid">
          ${sections.skills.clusters.map((cluster) => `
            <article class="skill-card">
              <h3>${escapeHtml(cluster.label)}</h3>
              <ul class="skill-list">
                ${cluster.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
              </ul>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="section-panel" id="experience" data-section="experience">
        ${renderQueueLine("experience")}
        <div class="section-header">
          <h2 class="section-title">${escapeHtml(sections.experience.label)}</h2>
          <div class="section-kicker">Timeline</div>
        </div>
        <div class="experience-grid">
          ${sections.experience.entries.map((entry) => `
            <article class="experience-card">
              <div class="experience-period">${escapeHtml(entry.period)}</div>
              <h3>${escapeHtml(entry.title)}</h3>
              <p class="experience-copy">${escapeHtml(entry.body)}</p>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="section-panel" id="projects" data-section="projects">
        ${renderQueueLine("projects")}
        <div class="section-header">
          <h2 class="section-title">Projects</h2>
          <div class="section-kicker">${projects.length} Entries</div>
        </div>
        <div class="projects-grid">
          ${projects.map((project) => `
            <article class="project-panel" id="project-${escapeHtml(project.id)}" data-section="project-${escapeHtml(project.id)}">
              <div class="project-media">
                ${renderProjectMedia(project)}
              </div>
              <div class="project-content">
                <div class="project-meta">${escapeHtml(project.platform)} · ${escapeHtml(project.year)}</div>
                <h3 class="project-title">${escapeHtml(project.title)}</h3>
                <div class="project-ratings">
                  ${renderSteamReviewBadge(project)}
                  ${renderItchRatingBadge(project)}
                </div>
                <p class="project-summary">${escapeHtml(project.summary)}</p>
                <div class="project-meta">Role: ${escapeHtml(project.role)}</div>
                <div class="project-meta">Team: ${escapeHtml(project.team.join(", "))}</div>
                <div class="project-links">
                  ${project.links.map((link) => `<a class="project-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join("")}
                </div>
              </div>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="section-panel" id="contact" data-section="contact">
        ${renderQueueLine("contact")}
        <div class="section-header">
          <h2 class="section-title">${escapeHtml(sections.contact.label)}</h2>
          <div class="section-kicker">Reach Out</div>
        </div>
        <div class="contact-grid">
          <article class="contact-card">
            <div class="contact-label">Availability</div>
            <p class="section-body">${escapeHtml(sections.contact.body)}</p>
          </article>
          <article class="contact-card">
            <div class="contact-label">Links</div>
            <div class="contact-links">
              ${sections.contact.links.map((link) => `<a class="contact-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join("")}
            </div>
          </article>
        </div>
      </section>
      </div>
    </div>
  `;

  appState.sectionElements.clear();
  dom.contentViewport.querySelectorAll("[data-section]").forEach((element) => {
    appState.sectionElements.set(element.dataset.section, element);
  });

  appState.queueElements.clear();
  dom.contentViewport.querySelectorAll("[data-queue-line]").forEach((element) => {
    appState.queueElements.set(element.dataset.queueLine, element);
  });
}

function renderProjectMedia(project) {
  const insetPoster = project.poster
    ? `<img class="project-poster-inset" src="${escapeHtml(project.poster)}" alt="${escapeHtml(project.title)} poster">`
    : "";
  const mainPoster = project.poster
    ? `<img class="project-media-poster" src="${escapeHtml(project.poster)}" alt="${escapeHtml(project.title)} poster" loading="lazy" decoding="async">`
    : "";

  if (project.video && /\.mp4($|\?)/i.test(project.video)) {
    return `
      ${mainPoster}
      <video class="project-media-asset" data-src="${escapeHtml(project.video)}" autoplay muted loop playsinline preload="none" poster="${escapeHtml(project.poster || "")}"></video>
      ${insetPoster}
    `;
  }

  if (project.video) {
    return `
      ${mainPoster}
      <img class="project-media-asset" data-src="${escapeHtml(project.video)}" alt="${escapeHtml(project.title)}" loading="lazy" decoding="async">
      ${insetPoster}
    `;
  }

  if (project.poster) {
    return `<img src="${escapeHtml(project.poster)}" alt="${escapeHtml(project.title)}">`;
  }

  return "";
}

function revealProjectMedia(mediaContainer) {
  mediaContainer.classList.add("is-loaded");
}

function loadProjectMediaAsset(asset) {
  if (!asset || asset.dataset.loaded === "true" || !asset.dataset.src) {
    return;
  }

  const mediaContainer = asset.closest(".project-media");
  const onReady = () => {
    asset.dataset.loaded = "true";
    revealProjectMedia(mediaContainer);
    asset.removeEventListener("load", onReady);
    asset.removeEventListener("loadeddata", onReady);
    asset.removeEventListener("error", onError);
  };

  const onError = () => {
    asset.dataset.loaded = "error";
    asset.removeEventListener("load", onReady);
    asset.removeEventListener("loadeddata", onReady);
    asset.removeEventListener("error", onError);
  };

  asset.addEventListener("load", onReady);
  asset.addEventListener("loadeddata", onReady);
  asset.addEventListener("error", onError);

  asset.src = asset.dataset.src;
  if (asset.tagName === "VIDEO") {
    asset.load();
  }
}

function initLazyProjectMedia() {
  appState.mediaObserver?.disconnect();

  const assets = [...dom.contentViewport.querySelectorAll(".project-media-asset[data-src]")];
  if (!assets.length) {
    return;
  }

  appState.mediaObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }

      loadProjectMediaAsset(entry.target);
      observer.unobserve(entry.target);
    });
  }, {
    root: null,
    rootMargin: "300px 0px",
    threshold: 0.01
  });

  assets.forEach((asset) => {
    appState.mediaObserver.observe(asset);
  });
}

function getElevatorParts() {
  const scene = dom.contentViewport.querySelector(".content-scene");
  const car = dom.contentViewport.querySelector(".scroll-elevator__car");
  return {
    scene,
    car,
    shaft: dom.contentViewport.querySelector(".scroll-elevator__shaft"),
    citizenLayer: dom.contentViewport.querySelector(".citizen-layer"),
    slotElements: [...dom.contentViewport.querySelectorAll(".scroll-elevator__car .scroll-elevator__slot")]
  };
}

function computeElevatorStops() {
  const { scene, car, shaft, slotElements } = getElevatorParts();
  if (!scene || !car || !shaft) {
    appState.elevator.stops = [];
    appState.floorData.clear();
    appState.elevator.slotOffsets = [];
    return;
  }

  const sceneRect = scene.getBoundingClientRect();
  const carRect = car.getBoundingClientRect();
  const carHeight = car.offsetHeight;
  const shaftHeight = shaft.offsetHeight;
  const maxTop = Math.max(0, shaftHeight - carHeight);
  const floorLineOffset = -2;
  const floorData = new Map();

  const stops = [...dom.contentViewport.querySelectorAll(".section-panel")]
    .map((panel) => {
      const key = panel.dataset.section;
      const floorY = panel.offsetTop + floorLineOffset;
      const queueElement = appState.queueElements.get(key);
      const queueSlots = queueElement ? [...queueElement.querySelectorAll(".section-queue__slot")] : [];
      const queuePositions = queueSlots.map((slot) => {
        const rect = slot.getBoundingClientRect();
        return {
          x: Math.round(rect.left - sceneRect.left),
          y: Math.round(rect.top - sceneRect.top)
        };
      });

      const queueStep = queuePositions.length > 1
        ? queuePositions[1].x - queuePositions[0].x
        : CITIZEN_WIDTH + 2;

      floorData.set(key, {
        key,
        floorY,
        roamMinX: panel.offsetLeft + 18,
        roamMaxX: panel.offsetLeft + panel.offsetWidth - CITIZEN_WIDTH - 12,
        queuePositions,
        queueStep
      });

      return {
        key,
        floorY,
        top: Math.round(Math.min(maxTop, Math.max(0, floorY - carHeight)))
      };
    })
    .filter((stop, index, list) => index === 0 || Math.abs(stop.top - list[index - 1].top) > 8);

  appState.floorData = floorData;
  appState.elevator.stops = stops;
  appState.elevator.slotOffsets = slotElements.map((slot) => {
    const rect = slot.getBoundingClientRect();
    return {
      x: Math.round(rect.left - carRect.left),
      y: Math.round(rect.top - carRect.top)
    };
  });
}

function applyElevatorShaftBounds() {
  const { shaft } = getElevatorParts();
  const track = dom.contentViewport.querySelector(".scroll-elevator__track");
  const stops = appState.elevator.stops;
  if (!shaft || !track || !stops?.length) {
    return;
  }

  const topStop = stops.reduce((best, stop) => (stop.top < best.top ? stop : best), stops[0]);
  const bottomStop = stops.reduce((best, stop) => (stop.floorY > best.floorY ? stop : best), stops[0]);
  const top = `${Math.round(topStop.top)}px`;
  const height = `${Math.round(bottomStop.floorY - topStop.top)}px`;

  shaft.style.top = top;
  shaft.style.bottom = "auto";
  shaft.style.height = height;

  track.style.top = top;
  track.style.bottom = "auto";
  track.style.height = height;
}

function applyElevatorTop(top) {
  const { car } = getElevatorParts();
  if (!car) {
    return;
  }

  car.style.top = `${Math.round(top)}px`;
}

function stopElevatorAnimation() {
  if (appState.elevator.animationFrame) {
    cancelAnimationFrame(appState.elevator.animationFrame);
    appState.elevator.animationFrame = null;
  }
}

function updateQueueLines(activeKey = null, availableSlots = 0) {
  appState.queueElements.forEach((element) => {
    const slots = [...element.querySelectorAll(".section-queue__slot")];
    slots.forEach((slot) => {
      slot.classList.remove("is-available");
    });
  });
}

function randomBetween(min, max) {
  return min + (Math.random() * (max - min));
}

function getRandomDecisionDelay() {
  return randomBetween(10000, 20000);
}

function getFloorKeys() {
  return [...appState.floorData.keys()];
}

function getRandomFloorKey(excludeKey = null) {
  const keys = getFloorKeys().filter((key) => key !== excludeKey);
  if (!keys.length) {
    return excludeKey;
  }

  return keys[Math.floor(Math.random() * keys.length)];
}

function getRandomFloorX(floorKey) {
  const floor = appState.floorData.get(floorKey);
  if (!floor) {
    return 0;
  }

  return Math.round(randomBetween(floor.roamMinX, floor.roamMaxX));
}

function getFloorCitizenTop(floorKey) {
  const floor = appState.floorData.get(floorKey);
  return floor ? Math.round(floor.floorY - CITIZEN_HEIGHT) : 0;
}

function getQueuePosition(floorKey, index) {
  const floor = appState.floorData.get(floorKey);
  if (!floor || !floor.queuePositions.length) {
    return { x: 0, y: 0 };
  }

  if (index < floor.queuePositions.length) {
    return floor.queuePositions[index];
  }

  const lastVisible = floor.queuePositions[floor.queuePositions.length - 1];
  return {
    x: Math.round(lastVisible.x + ((index - floor.queuePositions.length + 1) * floor.queueStep)),
    y: lastVisible.y
  };
}

function getElevatorExitPosition(floorKey) {
  const floor = appState.floorData.get(floorKey);
  if (!floor) {
    return { x: 0, y: 0 };
  }

  if (floor.queuePositions.length) {
    return {
      x: floor.queuePositions[0].x,
      y: getFloorCitizenTop(floorKey)
    };
  }

  return {
    x: floor.roamMinX,
    y: getFloorCitizenTop(floorKey)
  };
}

function getElevatorCarScenePosition() {
  const { scene, car } = getElevatorParts();
  if (!scene || !car) {
    return { x: 0, y: 0 };
  }

  const sceneRect = scene.getBoundingClientRect();
  const carRect = car.getBoundingClientRect();

  return {
    x: Math.round(carRect.left - sceneRect.left),
    y: Math.round(carRect.top - sceneRect.top)
  };
}

function enqueueCitizen(citizen) {
  const elevatorQueue = appState.elevator.queues.get(citizen.currentFloorKey);
  if (!elevatorQueue) {
    return;
  }

  citizen.state = "queued";
  citizen.targetX = citizen.x;
  citizen.targetY = citizen.y;
  elevatorQueue.push(citizen.id);
}

function chooseCitizenDestination(citizen, now) {
  if (citizen.state === "queued" || citizen.state === "riding") {
    return;
  }

  if (Math.random() < 0.9) {
    citizen.destinationFloorKey = citizen.currentFloorKey;
    citizen.destinationX = getRandomFloorX(citizen.currentFloorKey);
    citizen.targetX = citizen.destinationX;
    citizen.targetY = getFloorCitizenTop(citizen.currentFloorKey);
    citizen.state = "walking";
    return;
  }

  const targetFloorKey = getRandomFloorKey(citizen.currentFloorKey);
  citizen.destinationFloorKey = targetFloorKey;
  citizen.destinationX = getRandomFloorX(targetFloorKey);
  citizen.targetX = getQueuePosition(citizen.currentFloorKey, 0).x;
  citizen.targetY = getFloorCitizenTop(citizen.currentFloorKey);
  citizen.state = "heading_to_queue";
  citizen.nextDecisionAt = now + getRandomDecisionDelay();
}

function createCitizen(index) {
  const floorKey = getRandomFloorKey();
  const immediateDecision = Math.random() < 0.5;
  return {
    id: `citizen-${String(index + 1).padStart(3, "0")}`,
    currentFloorKey: floorKey,
    destinationFloorKey: floorKey,
    destinationX: getRandomFloorX(floorKey),
    x: getRandomFloorX(floorKey),
    y: getFloorCitizenTop(floorKey),
    targetX: null,
    targetY: null,
    state: "idle",
    nextDecisionAt: immediateDecision ? performance.now() : performance.now() + getRandomDecisionDelay(),
    elevatorSlotIndex: null
  };
}

function renderCitizens() {
  const { citizenLayer } = getElevatorParts();
  if (!citizenLayer) {
    return;
  }

  citizenLayer.innerHTML = appState.citizens.map((citizen) => (
    `<span class="citizen" data-citizen-id="${escapeHtml(citizen.id)}"></span>`
  )).join("");

  appState.citizenElements.clear();
  citizenLayer.querySelectorAll("[data-citizen-id]").forEach((element) => {
    appState.citizenElements.set(element.dataset.citizenId, element);
  });
}

function initCitizens(reset = false) {
  if (reset || !appState.citizens.length) {
    appState.citizens = Array.from({ length: CITIZEN_COUNT }, (_, index) => createCitizen(index));
    appState.elevator.queues = new Map(getFloorKeys().map((key) => [key, []]));
    renderCitizens();
  } else {
    appState.elevator.queues = new Map(getFloorKeys().map((key) => [key, []]));
  }

  appState.citizens.forEach((citizen) => {
    if (citizen.state === "queued") {
      const queue = appState.elevator.queues.get(citizen.currentFloorKey);
      queue?.push(citizen.id);
    }

    if (citizen.state === "riding") {
      return;
    }

    citizen.y = getFloorCitizenTop(citizen.currentFloorKey);
    const floor = appState.floorData.get(citizen.currentFloorKey);
    if (floor) {
      citizen.x = Math.max(floor.roamMinX, Math.min(floor.roamMaxX, citizen.x));
      if (typeof citizen.targetX === "number") {
        citizen.targetX = Math.max(floor.roamMinX, Math.min(floor.roamMaxX, citizen.targetX));
      }
      if (typeof citizen.targetY !== "number") {
        citizen.targetY = citizen.y;
      }
    }
  });

  updateCitizens(performance.now());
}

function updateQueuedCitizenTargets() {
  appState.elevator.queues.forEach((queue, floorKey) => {
    queue.forEach((citizenId, index) => {
      const citizen = appState.citizens.find((item) => item.id === citizenId);
      if (!citizen) {
        return;
      }

      const position = getQueuePosition(floorKey, index);
      citizen.targetX = position.x;
      citizen.targetY = position.y;
    });
  });
}

function handleElevatorArrival(floorKey) {
  const queue = appState.elevator.queues.get(floorKey) || [];
  const occupiedSlots = new Set();

  appState.citizens.forEach((citizen) => {
    if (citizen.state === "riding" && citizen.destinationFloorKey === floorKey) {
      const exitPosition = getElevatorExitPosition(floorKey);
      citizen.state = "walking";
      citizen.currentFloorKey = floorKey;
      citizen.x = exitPosition.x;
      citizen.y = exitPosition.y;
      citizen.targetX = citizen.destinationX;
      citizen.targetY = getFloorCitizenTop(floorKey);
      citizen.elevatorSlotIndex = null;
      citizen.nextDecisionAt = performance.now() + getRandomDecisionDelay();
      return;
    }

    if (citizen.state === "riding" && citizen.elevatorSlotIndex !== null) {
      occupiedSlots.add(citizen.elevatorSlotIndex);
    }
  });

  const freeSlots = Array.from({ length: ELEVATOR_CAPACITY }, (_, index) => index)
    .filter((index) => !occupiedSlots.has(index));

  while (queue.length && freeSlots.length) {
    const citizenId = queue.shift();
    const citizen = appState.citizens.find((item) => item.id === citizenId);
    if (!citizen) {
      continue;
    }

    citizen.elevatorSlotIndex = freeSlots.shift();
    const elevatorCar = getElevatorCarScenePosition();
    const slot = appState.elevator.slotOffsets?.[citizen.elevatorSlotIndex];
    if (slot) {
      citizen.x = elevatorCar.x + slot.x;
      citizen.y = elevatorCar.y + slot.y;
    }
    citizen.state = "riding";
  }
}

function moveCitizenTowardTarget(citizen, elapsed) {
  const targetX = typeof citizen.targetX === "number" ? citizen.targetX : citizen.x;
  const targetY = typeof citizen.targetY === "number" ? citizen.targetY : citizen.y;
  const dx = targetX - citizen.x;
  const dy = targetY - citizen.y;
  const distance = Math.hypot(dx, dy);

  if (distance <= 0.001) {
    citizen.x = targetX;
    citizen.y = targetY;
    return true;
  }

  const step = CITIZEN_SPEED_PX_PER_MS * elapsed;
  if (distance <= step) {
    citizen.x = targetX;
    citizen.y = targetY;
    return true;
  }

  citizen.x += (dx / distance) * step;
  citizen.y += (dy / distance) * step;
  return false;
}

function updateCitizens(now) {
  const elevatorCar = getElevatorCarScenePosition();
  const slotOffsets = appState.elevator.slotOffsets || [];
  const elapsed = Math.max(16, now - (appState.citizensLastUpdatedAt || now));
  appState.citizensLastUpdatedAt = now;

  updateQueuedCitizenTargets();

  appState.citizens.forEach((citizen) => {
    if (citizen.state === "riding") {
      const slot = slotOffsets[citizen.elevatorSlotIndex];
      if (slot) {
        citizen.x = elevatorCar.x + slot.x;
        citizen.y = elevatorCar.y + slot.y;
      }
      return;
    }

    if (citizen.state === "idle") {
      if (now >= citizen.nextDecisionAt) {
        chooseCitizenDestination(citizen, now);
      }
      return;
    }

    if (typeof citizen.targetX !== "number") {
      citizen.state = "idle";
      citizen.nextDecisionAt = now + getRandomDecisionDelay();
      return;
    }

    if (moveCitizenTowardTarget(citizen, elapsed)) {
      if (citizen.state === "heading_to_queue") {
        enqueueCitizen(citizen);
      } else if (citizen.state !== "queued") {
        citizen.state = "idle";
        citizen.nextDecisionAt = now + getRandomDecisionDelay();
      }
    }
  });

  appState.citizenElements.forEach((element, citizenId) => {
    const citizen = appState.citizens.find((item) => item.id === citizenId);
    if (!citizen) {
      return;
    }

    element.style.transform = `translate(${Math.round(citizen.x)}px, ${Math.round(citizen.y)}px)`;
  });
}

function updateElevatorDisplay(levelKey = "") {
  const { car } = getElevatorParts();
  const display = car?.querySelector(".scroll-elevator__display");
  if (!display) {
    return;
  }

  display.textContent = String(levelKey).replace(/^project-/i, "").toUpperCase() || "LEVEL";
}

function stepElevatorAnimation(timestamp) {
  const elevator = appState.elevator;
  const stops = elevator.stops;
  if (!stops.length) {
    updateCitizens(timestamp);
    return;
  }

  if (!elevator.phaseStartedAt) {
    elevator.phaseStartedAt = timestamp;
  }

  const currentIndex = elevator.currentStopIndex;
  const currentStop = stops[currentIndex];
  applyElevatorTop(currentStop.top);

  if (elevator.phase === "hold") {
    if (elevator.lastArrivedKey !== currentStop.key) {
      handleElevatorArrival(currentStop.key);
      elevator.lastArrivedKey = currentStop.key;
    }

    updateElevatorDisplay(currentStop.key);
    updateQueueLines(currentStop.key, ELEVATOR_CAPACITY);

    if ((timestamp - elevator.phaseStartedAt) >= elevator.holdMs) {
      let nextIndex = currentIndex + elevator.direction;
      if (nextIndex >= stops.length || nextIndex < 0) {
        elevator.direction *= -1;
        nextIndex = currentIndex + elevator.direction;
      }

      elevator.nextStopIndex = nextIndex;
      elevator.phase = "travel";
      elevator.phaseStartedAt = timestamp;
      elevator.lastArrivedKey = null;
    }
  } else {
    updateQueueLines(null, 0);

    const nextStop = stops[elevator.nextStopIndex];
    const progress = Math.min(1, (timestamp - elevator.phaseStartedAt) / elevator.travelMs);
    const eased = progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;

    applyElevatorTop(currentStop.top + ((nextStop.top - currentStop.top) * eased));

    if (progress >= 1) {
      elevator.currentStopIndex = elevator.nextStopIndex;
      elevator.phase = "hold";
      elevator.phaseStartedAt = timestamp;
      applyElevatorTop(nextStop.top);
    }
  }

  updateCitizens(timestamp);
  elevator.animationFrame = requestAnimationFrame(stepElevatorAnimation);
}

function initElevatorAnimation(reset = false) {
  computeElevatorStops();
  applyElevatorShaftBounds();
  stopElevatorAnimation();

  const elevator = appState.elevator;
  if (!elevator.stops.length) {
    return;
  }

  if (reset || elevator.currentStopIndex >= elevator.stops.length) {
    elevator.currentStopIndex = 0;
    elevator.direction = 1;
    elevator.phase = "hold";
    elevator.phaseStartedAt = 0;
    elevator.lastArrivedKey = null;
  }

  elevator.nextStopIndex = Math.min(elevator.currentStopIndex + 1, elevator.stops.length - 1);
  applyElevatorTop(elevator.stops[elevator.currentStopIndex].top);
  updateElevatorDisplay(elevator.stops[elevator.currentStopIndex].key);
  updateQueueLines(elevator.stops[elevator.currentStopIndex].key, ELEVATOR_CAPACITY);
  elevator.animationFrame = requestAnimationFrame(stepElevatorAnimation);
}

function scrollToTarget(target) {
  const element = appState.sectionElements.get(target);
  if (!element) {
    return;
  }

  appState.ui.activeTarget = target;
  updateActiveNav();
  element.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setMobileNavOpen(isOpen) {
  appState.ui.mobileNavOpen = isOpen;
  dom.appShell.classList.toggle("is-mobile-nav-open", isOpen);
  dom.mobileMenuToggle?.setAttribute("aria-expanded", String(isOpen));
  dom.mobileNavScrim.hidden = !isOpen;
}

function updateActiveNav() {
  appState.navElements.forEach((element) => {
    element.classList.toggle("is-active", element.dataset.target === appState.ui.activeTarget);
  });
}

function handleScrollSpy() {
  let bestTarget = appState.ui.activeTarget;
  let bestDistance = Infinity;

  appState.sectionElements.forEach((element, key) => {
    if (key === "hero") {
      return;
    }
    const rect = element.getBoundingClientRect();
    const distance = Math.abs(rect.top - 28);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTarget = key;
    }
  });

  if (bestTarget !== appState.ui.activeTarget) {
    appState.ui.activeTarget = bestTarget;
    updateActiveNav();
  }
}

function addEvents() {
  dom.contentViewport.addEventListener("scroll", handleScrollSpy, { passive: true });
  dom.mobileMenuToggle?.addEventListener("click", () => {
    setMobileNavOpen(!appState.ui.mobileNavOpen);
  });
  dom.mobileNavScrim?.addEventListener("click", () => {
    setMobileNavOpen(false);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900 && appState.ui.mobileNavOpen) {
      setMobileNavOpen(false);
    }
    initCitizens();
    initElevatorAnimation();
  }, { passive: true });
}

async function init() {
  appState.content = await loadContent();
  renderNav();
  renderContent();
  initLazyProjectMedia();
  computeElevatorStops();
  initCitizens(true);
  initElevatorAnimation(true);
  addEvents();
  updateActiveNav();
  try {
    await loadStoreRatings();
  } catch (error) {
    console.error(error);
    markStoreRatingsUnavailable();
  }
}

init().catch((error) => {
  console.error(error);
  dom.navRail.innerHTML = `
    <div class="nav-header">
      <h1 class="nav-title">Portfolio Error</h1>
      <div class="nav-intro">The content failed to load.</div>
    </div>
  `;
});
