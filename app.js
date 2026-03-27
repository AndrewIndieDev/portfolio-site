const dom = {
  appShell: document.getElementById("app"),
  mobileMenuToggle: document.getElementById("mobileMenuToggle"),
  mobileNavScrim: document.getElementById("mobileNavScrim"),
  navRail: document.getElementById("navRail"),
  contentViewport: document.getElementById("contentViewport")
};

const appState = {
  content: null,
  ui: {
    projectsExpanded: true,
    activeTarget: "about",
    mobileNavOpen: false
  },
  steamReviews: new Map(),
  itchRatings: new Map(),
  mediaObserver: null,
  sectionElements: new Map(),
  navElements: new Map()
};

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
  const response = await fetch("/api/store-ratings", {
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
    <div class="content-stack">
      <section class="hero-panel" data-section="hero">
        <h2 class="hero-title">${escapeHtml(site.title)}</h2>
        <div class="hero-copy">${escapeHtml(site.intro)}</div>
      </section>

      <section class="section-panel" id="about" data-section="about">
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
  `;

  appState.sectionElements.clear();
  dom.contentViewport.querySelectorAll("[data-section]").forEach((element) => {
    appState.sectionElements.set(element.dataset.section, element);
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
  }, { passive: true });
}

async function init() {
  appState.content = await loadContent();
  renderNav();
  renderContent();
  initLazyProjectMedia();
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
