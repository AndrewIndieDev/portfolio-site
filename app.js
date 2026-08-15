
const dom = {
  appShell: document.getElementById("app"),
  mobileMenuToggle: document.getElementById("mobileMenuToggle"),
  mobileNavScrim: document.getElementById("mobileNavScrim"),
  navRail: document.getElementById("navRail"),
  contentViewport: document.getElementById("contentViewport"),
  backgroundPreview: document.getElementById("backgroundPreview"),
  backgroundGame: document.getElementById("backgroundGame"),
  stageMode: document.getElementById("stageMode"),
  stageTitle: document.getElementById("stageTitle"),
  hudToggle: document.getElementById("hudToggle"),
  exitGame: document.getElementById("exitGame")
};

const STORE_RATINGS_ENDPOINT = "https://australia-southeast1-portfolio-boss-raid.cloudfunctions.net/getStoreRatings";

const appState = {
  content: null,
  ui: {
    activeTarget: "projects",
    mobileNavOpen: false,
    hudRetracted: false,
    backgroundProjectId: null,
    backgroundMode: "preview"
  },
  steamReviews: new Map(),
  itchRatings: new Map(),
  mediaObserver: null,
  sectionElements: new Map(),
  navElements: new Map(),
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
  const response = await fetch(STORE_RATINGS_ENDPOINT, {
    method: "GET",
    cache: "default"
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
    .map((link) => `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(link.label)}">${escapeHtml(link.label)}</a>`)
    .join("");

  dom.navRail.innerHTML = `
    <div class="nav-header">
      <img class="nav-monogram" src="images/logo.png" alt="" aria-hidden="true">
      <h1 class="nav-title">${escapeHtml(site.title)}</h1>
      <div class="nav-role">${escapeHtml(site.role)}</div>
      <div class="nav-intro">${escapeHtml(site.intro)}</div>
    </div>
    <div class="nav-navigation">
      <div class="tab-elevator" aria-hidden="true">
        <div class="tab-elevator-track"></div>
        <div class="tab-elevator-car"><span>01</span><i></i><i></i><i></i></div>
      </div>
      <div class="nav-list" role="tablist" aria-label="Portfolio sections">
        <button class="nav-button" role="tab" data-target="projects"><span class="nav-index">01</span><span>Work</span><span class="nav-count">${projects.length}</span></button>
        <button class="nav-button" role="tab" data-target="about"><span class="nav-index">02</span><span>About</span></button>
        <button class="nav-button" role="tab" data-target="skills"><span class="nav-index">03</span><span>Skills</span></button>
        <button class="nav-button" role="tab" data-target="experience"><span class="nav-index">04</span><span>Journey</span></button>
        <button class="nav-button" role="tab" data-target="contact"><span class="nav-index">05</span><span>Contact</span></button>
      </div>
    </div>
    <div class="nav-utility">
      <span class="nav-utility-label">Elsewhere</span>
      ${navUtilityLinks}
    </div>
  `;

  appState.navElements.clear();
  dom.navRail.querySelectorAll("[data-target]").forEach((element) => {
    appState.navElements.set(element.dataset.target, element);
    element.addEventListener("click", () => {
      showTab(element.dataset.target);
      if (window.matchMedia("(max-width: 900px)").matches) {
        setMobileNavOpen(false);
      }
    });
  });
}

function renderContent() {
  const { site, sections, projects } = appState.content;

  dom.contentViewport.innerHTML = `
    <div class="content-stack">
      <section class="section-panel tab-panel" id="projects" data-section="projects" role="tabpanel" aria-label="Selected work">
        <div class="section-header projects-header">
          <div>
            <div class="section-eyebrow">Unity developer · game designer</div>
            <h2 class="section-title">Selected <em>work</em></h2>
          </div>
          <div class="section-kicker">${projects.length} playable worlds</div>
        </div>
        <div class="projects-grid">
          ${projects.map((project, index) => `
            <article class="project-panel" id="project-${escapeHtml(project.id)}" data-project-id="${escapeHtml(project.id)}" tabindex="0">
              <div class="project-media">
                ${renderProjectMedia(project)}
              </div>
              <div class="project-content">
                <div class="project-number">${String(index + 1).padStart(2, "0")}</div>
                ${project.webBuild && project.backgroundReady ? `<button class="background-quick-play" type="button" data-play-background="${escapeHtml(project.id)}" aria-label="Play ${escapeHtml(project.title)} behind the portfolio HUD"><span aria-hidden="true">▶</span> Play Behind</button>` : ""}
                <div class="project-heading">
                  <h3 class="project-title">${escapeHtml(project.title)}</h3>
                  <div class="project-meta">${escapeHtml(project.platform)} · ${escapeHtml(project.year)}</div>
                </div>
                <div class="project-details">
                  <p class="project-summary">${escapeHtml(project.summary)}</p>
                  <div class="project-role">${escapeHtml(project.role)}</div>
                  <div class="project-ratings">
                    ${renderSteamReviewBadge(project)}
                    ${renderItchRatingBadge(project)}
                  </div>
                  <div class="project-links">
                    ${project.links.map((link) => `<a class="project-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} <span aria-hidden="true">↗</span></a>`).join("")}
                  </div>
                </div>
              </div>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="section-panel tab-panel" id="about" data-section="about" role="tabpanel" hidden>
        <div class="section-header">
          <div>
            <div class="section-eyebrow">Player profile</div>
            <h2 class="section-title">A little <em>about me</em></h2>
          </div>
          <div class="section-kicker">10+ years in Unity</div>
        </div>
        <div class="about-body">
          <p class="section-summary">${escapeHtml(sections.about.summary)}</p>
          <div class="profile-facts"><span>Brisbane, AU</span><span>Unity since 2014</span><span>Programming × Design</span></div>
        </div>
      </section>

      <section class="section-panel tab-panel" id="skills" data-section="skills" role="tabpanel" hidden>
        <div class="section-header">
          <div>
            <div class="section-eyebrow">Toolkit</div>
            <h2 class="section-title">Skills &amp; <em>specialties</em></h2>
          </div>
          <div class="section-kicker">Capabilities</div>
        </div>
        <div class="skills-grid">
          ${sections.skills.clusters.map((cluster) => `
            <article class="skill-card">
              <h3>${escapeHtml(cluster.label)}</h3>
              <p class="skill-summary">${escapeHtml(cluster.summary || "")}</p>
              <div class="skill-list">${cluster.items.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
            </article>
          `).join("")}
        </div>
      </section>

      <section class="section-panel tab-panel" id="experience" data-section="experience" role="tabpanel" hidden>
        <div class="section-header">
          <div>
            <div class="section-eyebrow">Career save file</div>
            <h2 class="section-title">Experience <em>timeline</em></h2>
          </div>
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

      <section class="section-panel tab-panel" id="contact" data-section="contact" role="tabpanel" hidden>
        <div class="section-header">
          <div>
            <div class="section-eyebrow">Start a conversation</div>
            <h2 class="section-title">Let's build <em>something good</em></h2>
          </div>
          <div class="section-kicker">Reach Out</div>
        </div>
        <div class="contact-grid">
          <article class="contact-card">
            <p class="contact-pitch">${escapeHtml(sections.contact.body)}</p>
            <div class="contact-links">
              ${sections.contact.links.map((link) => `<a class="contact-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} <span aria-hidden="true">↗</span></a>`).join("")}
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

function getProject(projectId) {
  return appState.content.projects.find((project) => project.id === projectId) || null;
}

function setStageLabel(mode, title) {
  dom.stageMode.textContent = mode;
  dom.stageTitle.textContent = title;
}

function setBackgroundPreview(project) {
  if (!project || appState.ui.backgroundMode === "game") {
    return;
  }

  appState.ui.backgroundProjectId = project.id;
  dom.backgroundPreview.pause();
  dom.backgroundPreview.removeAttribute("src");
  dom.backgroundPreview.poster = project.poster || "";
  dom.backgroundPreview.hidden = false;

  if (project.video) {
    dom.backgroundPreview.src = project.video;
    dom.backgroundPreview.load();
    dom.backgroundPreview.play().catch(() => {});
  }

  setStageLabel("Background preview", project.title);
  dom.contentViewport.querySelectorAll(".project-panel").forEach((card) => {
    card.classList.toggle("is-stage-active", card.dataset.projectId === project.id);
  });
}

function setHudRetracted(isRetracted) {
  appState.ui.hudRetracted = isRetracted;
  document.body.classList.toggle("hud-is-retracted", isRetracted);
  dom.appShell.classList.toggle("is-hud-retracted", isRetracted);
  dom.hudToggle.textContent = isRetracted ? "Expand HUD" : "Retract HUD";
  dom.hudToggle.setAttribute("aria-expanded", String(!isRetracted));
  if (isRetracted) {
    setMobileNavOpen(false);
  }
}

function launchBackgroundGame(projectId) {
  const project = getProject(projectId);
  if (!project?.webBuild || !project.backgroundReady) {
    return;
  }

  appState.ui.backgroundProjectId = project.id;
  appState.ui.backgroundMode = "game";
  dom.backgroundPreview.pause();
  dom.backgroundPreview.hidden = true;
  dom.backgroundGame.title = `${project.title} playable web build`;
  dom.backgroundGame.src = project.webBuild;
  dom.backgroundGame.hidden = false;
  dom.exitGame.hidden = false;
  setStageLabel("Web build running", project.title);
  setHudRetracted(true);
}

function exitBackgroundGame() {
  const project = getProject(appState.ui.backgroundProjectId) || appState.content.projects[0];
  dom.backgroundGame.src = "about:blank";
  dom.backgroundGame.hidden = true;
  dom.exitGame.hidden = true;
  appState.ui.backgroundMode = "preview";
  setHudRetracted(false);
  setBackgroundPreview(project);
}

function initBackgroundStage() {
  const defaultProject = appState.content.projects.find((project) => project.video) || appState.content.projects[0];
  setBackgroundPreview(defaultProject);

  dom.contentViewport.querySelectorAll("[data-project-id]").forEach((card) => {
    const selectPreview = (event) => {
      if (event.target.closest("a, button")) {
        return;
      }
      setBackgroundPreview(getProject(card.dataset.projectId));
    };
    card.addEventListener("click", selectPreview);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectPreview(event);
      }
    });
  });

  dom.contentViewport.querySelectorAll("[data-play-background]").forEach((button) => {
    button.addEventListener("click", () => launchBackgroundGame(button.dataset.playBackground));
  });
}

function showTab(target) {
  if (!appState.sectionElements.has(target)) {
    return;
  }

  appState.ui.activeTarget = target;
  appState.sectionElements.forEach((panel, key) => {
    panel.hidden = key !== target;
  });
  updateActiveNav();
}

function setMobileNavOpen(isOpen) {
  appState.ui.mobileNavOpen = isOpen;
  dom.appShell.classList.toggle("is-mobile-nav-open", isOpen);
  dom.mobileMenuToggle?.setAttribute("aria-expanded", String(isOpen));
  dom.mobileNavScrim.hidden = !isOpen;
}

function updateActiveNav() {
  let activeIndex = 0;
  appState.navElements.forEach((element) => {
    const isActive = element.dataset.target === appState.ui.activeTarget;
    element.classList.toggle("is-active", isActive);
    element.setAttribute("aria-selected", String(isActive));
    element.tabIndex = isActive ? 0 : -1;
    if (isActive) {
      activeIndex = [...appState.navElements.keys()].indexOf(element.dataset.target);
    }
  });
  dom.navRail.style.setProperty("--active-floor", activeIndex);
  const elevatorDisplay = dom.navRail.querySelector(".tab-elevator-car span");
  if (elevatorDisplay) elevatorDisplay.textContent = String(activeIndex + 1).padStart(2, "0");
}

function addEvents() {
  dom.hudToggle.addEventListener("click", () => setHudRetracted(!appState.ui.hudRetracted));
  dom.exitGame.addEventListener("click", exitBackgroundGame);
  dom.mobileMenuToggle?.addEventListener("click", () => {
    setMobileNavOpen(!appState.ui.mobileNavOpen);
  });
  dom.mobileNavScrim?.addEventListener("click", () => {
    setMobileNavOpen(false);
  });
  dom.navRail.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    const tabs = [...dom.navRail.querySelectorAll("[role='tab']")];
    const currentIndex = tabs.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    event.preventDefault();
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
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
  initBackgroundStage();
  addEvents();
  showTab(appState.ui.activeTarget);
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
