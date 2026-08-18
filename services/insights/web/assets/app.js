// =============================================================================
// app.js — entrypoint + client-side hash router for the multi-page dashboard.
// ES module; relies on the global `echarts` loaded before it. Fetches same-origin
// /api data, renders one view per route into #view-root, and manages the ECharts
// instance lifecycle (dispose on route change, debounced resize).
// =============================================================================
import {
  el, mount, statTile, indicatorCard, newsCard, emptyState, sectionHeader, segmented, viewMeta,
} from "/assets/components.js";
import { lineOption, twoSeriesOption } from "/assets/charts.js";

const $ = (id) => document.getElementById(id);

// Indicator display order (Inflation, Unemployment, Fed Funds) reused across pages.
const INDICATOR_ORDER = [
  { id: "INFLATION", label: "Inflation (CPI, YoY)" },
  { id: "UNRATE", label: "Unemployment" },
  { id: "FEDFUNDS", label: "Fed Funds" },
];

// -----------------------------------------------------------------------------
// Data fetching (with a tiny cache so navigating between pages doesn't refetch).
// -----------------------------------------------------------------------------
const cache = new Map();

async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  const data = await res.json();
  cache.set(path, data);
  return data;
}

// -----------------------------------------------------------------------------
// ECharts instance lifecycle. All live instances are tracked so we can dispose
// them on route change (their DOM nodes are replaced) and resize them together.
// -----------------------------------------------------------------------------
const instances = new Set();

function renderChart(node, option) {
  let chart = echarts.getInstanceByDom(node);
  if (!chart) {
    chart = echarts.init(node, null, { renderer: "canvas" });
    instances.add(chart);
  }
  chart.setOption(option, true); // notMerge so swaps are clean
  return chart;
}

function disposeCharts() {
  for (const c of instances) c.dispose();
  instances.clear();
}

// Dispose only the chart instances mounted inside a given container (used when
// swapping a segmented sub-view without a full route change).
function disposeChartsIn(container) {
  for (const node of container.querySelectorAll(".chart")) {
    const chart = echarts.getInstanceByDom(node);
    if (chart) {
      instances.delete(chart);
      chart.dispose();
    }
  }
}

// -----------------------------------------------------------------------------
// Error surfaces — always inline notes, never a blank page.
// -----------------------------------------------------------------------------
function showError(message) {
  const banner = $("error-banner");
  banner.textContent = `Couldn’t load this view: ${message}. Please retry; if it persists, contact the Insights team.`;
  banner.hidden = false;
}

function clearError() {
  const banner = $("error-banner");
  banner.hidden = true;
  banner.textContent = "";
}

function inlineNote(text) {
  return el("div", { className: "inline-note", text });
}

// -----------------------------------------------------------------------------
// "Data as of" pill (top bar). Derived from the UNRATE series' as-of date.
// Fetched once at boot; failure is non-fatal (pill just stays hidden).
// -----------------------------------------------------------------------------
async function initAsOfPill() {
  try {
    const series = await getJSON("/api/series/UNRATE");
    $("asof-date").textContent = series.as_of;
    $("asof-pill").hidden = false;
  } catch (e) {
    console.warn("as-of pill unavailable:", e);
  }
}

// =============================================================================
// Views
// =============================================================================

// --- Home: "Market Brief" news + optional latest-value stat strip. -----------
async function renderHome(root) {
  const section = el("section", { className: "section" });

  // Top strip: latest value of each indicator (last point of each series).
  const strip = el("div", { className: "stat-strip" });
  section.appendChild(strip);
  try {
    const series = await Promise.all(INDICATOR_ORDER.map((i) => getJSON(`/api/series/${i.id}`)));
    const tiles = INDICATOR_ORDER.map((i, idx) => {
      const s = series[idx];
      const latest = s.points[s.points.length - 1];
      return statTile({
        label: i.label,
        value: latest ? latest.value.toFixed(1) : "—",
        units: "%",
        meta: latest ? `Latest · ${latest.date}` : "",
      });
    });
    mount(strip, tiles);
  } catch (e) {
    console.warn("stat strip unavailable:", e);
    mount(strip, inlineNote("Latest indicator values are unavailable right now."));
  }

  // Market Brief — editorial news list.
  section.appendChild(sectionHeader({
    title: "Market Brief",
    sub: "Today’s macro, rates, inflation and markets read from the FinTechCo desk.",
  }));

  const brief = el("div", { className: "news-list" });
  section.appendChild(brief);
  root.appendChild(section);

  const { news } = await getJSON("/api/news");
  if (!news || !news.length) {
    mount(brief, inlineNote("No briefing items available."));
    return;
  }
  mount(brief, news.map(newsCard));
}

// --- Financial Indicators → Macro: indicator cards + inflation-vs-unemployment. ----
const MACRO_VIEW_OPTIONS = [
  { id: "cards", label: "Key indicators" },
  { id: "inflation-unemployment", label: "Inflation vs. Unemployment" },
];

async function renderIndicatorCards(container) {
  const cardsSection = el("section", { className: "section" });
  cardsSection.appendChild(sectionHeader({
    title: "Key indicators",
    sub: "Full monthly history · U.S. series via FRED",
  }));
  const grid = el("div", { className: "card-grid" });
  cardsSection.appendChild(grid);
  container.appendChild(cardsSection);

  const seriesById = {};
  await Promise.all(
    INDICATOR_ORDER.map(async ({ id }) => {
      seriesById[id] = await getJSON(`/api/series/${id}`);
    }),
  );

  const chartMounts = [];
  for (const { id } of INDICATOR_ORDER) {
    const series = seriesById[id];
    const ind = series.indicator;
    const latest = series.points[series.points.length - 1];
    const { card, chartEl } = indicatorCard({
      title: ind.title,
      value: latest ? latest.value.toFixed(1) : "—",
      units: "%",
      meta: latest ? `Latest · ${latest.date} · ${ind.frequency}` : ind.frequency,
    });
    grid.appendChild(card);
    chartMounts.push([chartEl, lineOption(series, ind)]);
  }
  // Render after cards are in the DOM (ECharts needs measurable dimensions).
  for (const [node, option] of chartMounts) renderChart(node, option);
}

// SCRUM-7 — is the Phillips-curve tradeoff still holding? Dual-line time series
// (chosen over a scatter so the tradeoff's evolution over a shared timeline reads
// at a glance) built from the paired /api/views/inflation-unemployment endpoint.
async function renderInflationUnemployment(container) {
  const section = el("section", { className: "section" });
  section.appendChild(sectionHeader({
    title: "Inflation vs. Unemployment",
    sub: "Is the Phillips-curve tradeoff still holding? · U.S. series via FRED",
  }));

  const chartEl = el("div", { className: "chart" });
  section.appendChild(el("div", { className: "card" }, [chartEl]));
  container.appendChild(section);

  const [view, { indicators }] = await Promise.all([
    getJSON("/api/views/inflation-unemployment"),
    getJSON("/api/indicators"),
  ]);
  const sourceFor = (id) => indicators.find((i) => i.id === id)?.source;

  const dates = view.points.map((p) => p.date);
  const inflation = view.points.map((p) => p.inflation);
  const unemployment = view.points.map((p) => p.unemployment);
  renderChart(
    chartEl,
    twoSeriesOption(dates, inflation, unemployment, "Inflation (YoY %)", "Unemployment (%)"),
  );

  container.appendChild(viewMeta({
    sources: [...new Set([sourceFor("INFLATION"), sourceFor("UNRATE")].filter(Boolean))],
    methodology:
      "Inflation is the year-over-year % change in the CPI (All Urban Consumers); " +
      "unemployment is the seasonally adjusted civilian unemployment rate. Both are aligned " +
      "to a common monthly index and months where either series is unavailable are dropped.",
    disclaimer: view.disclaimer,
    decisions: [
      {
        question: "Scatter (classic Phillips-curve plot) or dual-line time series?",
        choice: "Dual-line time series",
        rationale: "Reads more clearly whether the tradeoff has weakened over a shared timeline than a scatter would.",
      },
    ],
  }));
}

async function renderMacro(root) {
  const toggleSection = el("div", { className: "section" });
  const mountPoint = el("div");
  root.appendChild(toggleSection);
  root.appendChild(mountPoint);

  let active = MACRO_VIEW_OPTIONS[0].id;

  const renderActive = async () => {
    disposeChartsIn(mountPoint);
    mount(mountPoint, []);
    if (active === "inflation-unemployment") await renderInflationUnemployment(mountPoint);
    else await renderIndicatorCards(mountPoint);
  };

  toggleSection.appendChild(segmented({
    options: MACRO_VIEW_OPTIONS,
    selected: active,
    ariaLabel: "Macro view",
    onChange: (id) => {
      active = id;
      renderActive().catch((e) => {
        console.error("Macro sub-view render error:", e);
        showError(e.message || "unknown error");
      });
    },
  }));

  await renderActive();
}

// --- Empty placeholder pages -------------------------------------------------
function renderComingSoon(root, title, message) {
  root.appendChild(el("section", { className: "section" }, [emptyState({ title, message })]));
}
const renderMicro = (root) =>
  renderComingSoon(root, "Micro indicators — coming soon", "Firm- and household-level series (spending, credit, delinquency) will land here.");
const renderTrends = (root) =>
  renderComingSoon(root, "Trends — coming soon", "Cross-indicator trend decompositions and regime markers are in the works.");
const renderMarkets = (root) =>
  renderComingSoon(root, "Markets — coming soon", "Rates, curves and cross-asset context will be wired up in a later release.");

// =============================================================================
// Router
// =============================================================================
const ROUTES = {
  "#/home": { title: "Home", render: renderHome },
  "#/indicators/macro": { title: "Financial Indicators · Macro", render: renderMacro },
  "#/indicators/micro": { title: "Financial Indicators · Micro", render: renderMicro },
  "#/trends": { title: "Trends", render: renderTrends },
  "#/markets": { title: "Markets", render: renderMarkets },
};
const DEFAULT_ROUTE = "#/home";

function currentRoute() {
  const hash = location.hash || DEFAULT_ROUTE;
  return ROUTES[hash] ? hash : DEFAULT_ROUTE;
}

function setActiveNav(hash) {
  for (const link of document.querySelectorAll(".nav__link")) {
    const active = link.dataset.route === hash;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function handleRoute() {
  clearError();
  disposeCharts(); // tear down old instances before their nodes are replaced

  const hash = currentRoute();
  const route = ROUTES[hash];
  setActiveNav(hash);
  $("page-title").textContent = route.title;

  const root = $("view-root");
  mount(root, []); // clear previous view
  window.scrollTo(0, 0);

  try {
    await route.render(root);
  } catch (e) {
    console.error("View render error:", e);
    showError(e.message || "unknown error");
    if (!root.hasChildNodes()) {
      mount(root, el("section", { className: "section" }, [
        emptyState({ title: "Data unavailable", message: "This view couldn’t be loaded. Please retry shortly." }),
      ]));
    }
  }
}

// =============================================================================
// Boot
// =============================================================================
function main() {
  if (typeof echarts === "undefined") {
    showError("charting library failed to load");
    return;
  }

  initAsOfPill();
  window.addEventListener("hashchange", handleRoute);

  // Normalize to the default route so the first paint always has a valid hash.
  // If we rewrite the hash, the resulting `hashchange` drives the first render;
  // otherwise render the (already valid) current route directly. Avoids a
  // double initial render.
  if (!ROUTES[location.hash]) {
    location.replace(DEFAULT_ROUTE);
  } else {
    handleRoute();
  }

  // Keep charts crisp on resize / screen-share layout changes (debounced).
  let raf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => instances.forEach((c) => c.resize()));
  });
}

main();
