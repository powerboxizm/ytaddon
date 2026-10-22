const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { YouTube } = require("youtube-sr");

const MIN_MINUTES = 70;
const MAX_RESULTS = 8;
const RUNTIME_LOW = 0.88;
const RUNTIME_HIGH = 1.10;
const PREFER_LANG = "English"; // ranks this language first. Set to null to turn off
const CINEMETA = "https://v3-cinemeta.strem.io";
const PORT = process.env.PORT || 7000;

const BAD_WORDS = /\b(reviews?|reviewed|reacts?|reacting|reactions?|recaps?|explained|explanation|breakdown|analysis|analy[sz]ed|ending|trailers?|teasers?|clips?|scenes?|behind the scenes|making of|interviews?|podcast|commentary|ranked|ranking|top \d+|vs|versus|spoilers?|first time watching|watch along|watchalong|discussion|essay|retrospective|history of|facts|trivia|parody|fan made|fan film|tribute|compilation|gameplay)\b/i;
const BAD_CHANNELS = /review|recap|react|explain|trailer|clips|breakdown|analysis|critic|rank/i;

// ---------- Language detection (from title text only) ----------
const LANG_WORDS = {
  English: /\b(english|eng)\b/i,
  Hindi: /\b(hindi|हिंदी|हिन्दी)\b/i,
  Tamil: /\btamil\b/i,
  Telugu: /\btelugu\b/i,
  Malayalam: /\bmalayalam\b/i,
  Kannada: /\bkannada\b/i,
  Bengali: /\b(bengali|bangla)\b/i,
  Punjabi: /\bpunjabi\b/i,
  Urdu: /\burdu\b/i,
  Spanish: /\b(spanish|espa[ñn]ol|castellano|latino|pel[ií]cula completa)\b/i,
  Portuguese: /\b(portuguese|portugu[eê]s|dublado|filme completo)\b/i,
  French: /\b(french|fran[cç]ais|vf|film complet)\b/i,
  German: /\b(german|deutsch|ganzer film|kompletter film)\b/i,
  Italian: /\b(italian|italiano|film completo)\b/i,
  Russian: /\b(russian|русский|фильм)\b/i,
  Turkish: /\b(turkish|t[uü]rk[cç]e|film izle)\b/i,
  Arabic: /\b(arabic|عربي)\b/i,
  Indonesian: /\b(indonesian|bahasa|film lengkap)\b/i,
  Korean: /\b(korean|한국어)\b/i,
  Japanese: /\b(japanese|日本語)\b/i,
  Chinese: /\b(chinese|mandarin|cantonese|中文|国语|粤语)\b/i,
  Thai: /\b(thai|พากย์ไทย)\b/i,
  Vietnamese: /\b(vietnamese|thuy[eế]t minh|phim)\b/i,
  Polish: /\b(polish|polski|lektor)\b/i,
  Dutch: /\b(dutch|nederlands)\b/i,
  Persian: /\b(persian|farsi|فارسی)\b/i,
};

const SCRIPTS = [
  ["Hindi", /[\u0900-\u097F]/],
  ["Bengali", /[\u0980-\u09FF]/],
  ["Tamil", /[\u0B80-\u0BFF]/],
  ["Telugu", /[\u0C00-\u0C7F]/],
  ["Arabic", /[\u0600-\u06FF]/],
  ["Hebrew", /[\u0590-\u05FF]/],
  ["Thai", /[\u0E00-\u0E7F]/],
  ["Korean", /[\uAC00-\uD7AF]/],
  ["Japanese", /[\u3040-\u30FF]/],
  ["Chinese", /[\u4E00-\u9FFF]/],
  ["Russian", /[\u0400-\u04FF]/],
  ["Greek", /[\u0370-\u03FF]/],
];

const SUBS_RE = /\b(?:with\s+)?(?:(?:english|eng|spanish|french|german|hindi|arabic|portuguese|indonesian|turkish|italian|russian)\s+)?(?:subs?|subbed|subtitles?|hardsubs?)\b/gi;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function detectLanguage(title, movieName) {
  let t = (title || "").replace(new RegExp(escapeRe(movieName), "ig"), " ");
  const t2 = t.replace(SUBS_RE, " ");
  const subs = t2 !== t;
  const dubbed = /\b(dubbed|dubbing|dub)\b/i.test(t2);
  const dual = /\b(dual audio|multi audio|multi-audio)\b/i.test(t2);

  let langs = Object.entries(LANG_WORDS)
    .filter(([, re]) => re.test(t2))
    .map(([name]) => name);

  if (!langs.length) {
    const hit = SCRIPTS.find(([, re]) => re.test(t2));
    if (hit) langs = [hit[0]];
  }

  let assumed = false;
  if (!langs.length) {
    langs = ["English"];
    assumed = true;
  }
  return { langs, dubbed, subs, dual, assumed };
}

function langLabel(info) {
  let s = info.langs.join(" + ") + (info.assumed ? "?" : "");
  if (info.dual && info.langs.length < 2) s += " · ᴅᴜᴀʟ";
  if (info.dubbed) s += " · ᴅᴜʙ";
  if (info.subs) s += " · sᴜʙ";
  return s;
}
// ---------------------------------------------------------------

const manifest = {
  id: "org.example.youtubemoviesearch",
  version: "3.5.0",
  name: "YouTube Movie Search",
  description: "YouTube full-movie results for movies you open in Stremio",
  resources: ["stream"],
  types: ["movie"],
  idPrefixes: ["tt"],
  catalogs: [],
};

const norm = (s) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function looksLikeNonMovie(title, movieName) {
  const stripped = norm(title).replace(norm(movieName), " ");
  return BAD_WORDS.test(stripped);
}

function parseRuntime(r) {
  if (!r) return null;
  const s = String(r).toLowerCase();
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  if (h || m) return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  const n = s.match(/\d+/);
  return n ? +n[0] : null;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function fmtMins(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function fmtViews(n) {
  if (!n) return "";
  return new Intl.NumberFormat("en", { notation: "compact" }).format(n);
}

// Confidence that this video is the right movie (0-100)
function matchPercent(v, name, year, runtime) {
  const mins = v.duration / 60000;
  const t = v.title || "";
  let pts = 30; // title contains the movie name
  const leftover = norm(t.replace(/[\(\[].*?[\)\]]/g, " "))
    .replace(norm(name), " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b(full|movie|film|hd|4k|1080p|720p|english|eng|subtitles?|subs?|dubbed|official|free|complete|new|latest|uncut)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  pts += leftover <= 2 ? 20 : leftover <= 4 ? 10 : 0;
  const years = t.match(/\b(19|20)\d{2}\b/g) || [];
  if (year && years.includes(year)) pts += 15;
  else if (!years.length) pts += 5;
  if (runtime) {
    const d = Math.abs(mins - runtime) / runtime;
    pts += d <= 0.03 ? 30 : d <= 0.06 ? 24 : d <= 0.1 ? 16 : d <= 0.15 ? 8 : 0;
  } else pts += 15;
  if (/full movie/i.test(t)) pts += 5;
  return Math.min(100, Math.round((pts / (runtime ? 100 : 85)) * 100));
}

function formatStream(v, year, runtime, movieName) {
  const mins = v.duration / 60000;
  const name = `     \n⁽ʸᵗ⁾ ⚡\n  〈Full Movie〉`;

  const lines = [];
  lines.push(`✎  ${v.title || ""}`);
  if (year) lines.push(`▦  ${year}`);
  lines.push(`♬  ${langLabel(detectLanguage(v.title, movieName))}`);
  const views = fmtViews(v.views);
  const exp = runtime ? ` (movie: ${fmtMins(runtime)}) ✓` : "";
  lines.push(`◈ ${fmtMins(mins)}${exp}${views ? ` · ▷ ${views}` : ""}`);
  const channel = v.channel?.name ? ` · ${truncate(v.channel.name, 20)}` : "";
  lines.push(`◎  ${matchPercent(v, movieName, year, runtime)}% match`);
  lines.push(`⛉ YouTube${channel}`);
  return { name, title: lines.join("\n") };
}

async function getMeta(imdbId) {
  const res = await fetch(`${CINEMETA}/meta/movie/${imdbId}.json`);
  const { meta } = await res.json();
  return meta || null;
}

// ---------- Genre check (title vs Cinemeta genres) ----------
const GENRE_WORDS = [
  ["Horror", /\bhorror\b/i],
  ["Comedy", /\b(comedy|comedies)\b/i],
  ["Action", /\baction\b/i],
  ["Romance", /\b(romance|romantic)\b/i],
  ["Thriller", /\b(thriller|suspense)\b/i],
  ["Sci-Fi", /\b(sci[- ]?fi|science fiction)\b/i],
  ["Animation", /\b(animated|animation|cartoon)\b/i],
  ["Documentary", /\b(documentary|docu)\b/i],
  ["Drama", /\bdrama\b/i],
  ["Crime", /\bcrime\b/i],
  ["War", /\bwar (movie|film)\b/i],
  ["Western", /\bwestern\b/i],
  ["Fantasy", /\bfantasy\b/i],
  ["Mystery", /\bmystery\b/i],
  ["Family", /\bfamily (movie|film)\b/i],
  ["Musical", /\bmusical\b/i],
  ["Adventure", /\badventure\b/i],
  ["Biography", /\b(biography|biopic)\b/i],
];

const GENRE_OK = {
  Horror: ["Horror", "Thriller", "Mystery"],
  Comedy: ["Comedy"],
  Action: ["Action", "Adventure", "Thriller", "Crime"],
  Romance: ["Romance", "Drama"],
  Thriller: ["Thriller", "Mystery", "Crime", "Horror"],
  "Sci-Fi": ["Sci-Fi", "Science Fiction", "Fantasy"],
  Animation: ["Animation", "Family"],
  Documentary: ["Documentary"],
  Drama: ["Drama", "Biography", "History", "Romance", "War", "Crime"],
  Crime: ["Crime", "Thriller", "Mystery", "Drama"],
  War: ["War", "History", "Action", "Drama"],
  Western: ["Western"],
  Fantasy: ["Fantasy", "Adventure", "Sci-Fi"],
  Mystery: ["Mystery", "Thriller", "Crime", "Horror"],
  Family: ["Family", "Animation", "Comedy", "Adventure"],
  Musical: ["Musical", "Music"],
  Adventure: ["Adventure", "Action", "Fantasy", "Sci-Fi", "Animation"],
  Biography: ["Biography", "History", "Drama"],
};

function genreMismatch(title, movieName, genres) {
  if (!genres || !genres.length) return "";
  const esc = movieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = (title || "").replace(new RegExp(esc, "ig"), " ");
  const have = genres.map((g) => String(g).toLowerCase());
  const found = GENRE_WORDS.filter(([, re]) => re.test(t)).map(([g]) => g);
  if (!found.length) return "";
  const ok = found.some((g) =>
    (GENRE_OK[g] || [g]).some((x) => have.includes(x.toLowerCase()))
  );
  return ok ? "" : found.join("/");
}
// ------------------------------------------------------------

async function searchYouTube(name, year, runtime, genres) {
  const queries = [`${name} ${year || ""} full movie`.trim(), `${name} full movie`];
  const seen = new Map();
  for (const q of queries) {
    try {
      const results = await YouTube.search(q, { limit: 15, type: "video" });
      for (const v of results) if (!seen.has(v.id)) seen.set(v.id, v);
    } catch (e) {
      console.log("YouTube search failed:", q, e.message);
    }
  }

  const wanted = norm(name);
  const lo = runtime ? runtime * RUNTIME_LOW : MIN_MINUTES;
  const hi = runtime ? runtime * RUNTIME_HIGH : Infinity;

  const score = (v) => {
    const t = v.title || "";
    let s = (year && t.includes(year) ? 2 : 0) + (/full movie/i.test(t) ? 1 : 0);
    if (PREFER_LANG && detectLanguage(t, name).langs.includes(PREFER_LANG)) s += 4;
    return s;
  };
  const diff = (v) => (runtime ? Math.abs(v.duration / 60000 - runtime) : 0);

  return [...seen.values()]
    .filter((v) => {
      const mins = v.duration / 60000;
      const ok = mins >= lo && mins <= hi;
      if (!ok) console.log(`  skip (runtime ${Math.round(mins)}m): ${v.title}`);
      return ok;
    })
    .filter((v) => norm(v.title || "").includes(wanted))
    .filter((v) => !looksLikeNonMovie(v.title || "", name))
    .filter((v) => {
      const bad = genreMismatch(v.title || "", name, genres);
      if (bad) console.log("  skip (genre " + bad + "): " + v.title);
      return !bad;
    })
    .filter((v) => {
      const bad = BAD_CHANNELS.test(v.channel?.name || "");
      if (bad) console.log(`  skip (channel ${v.channel?.name}): ${v.title}`);
      return !bad;
    })
    .sort(
      (x, y) =>
        matchPercent(y, name, year, runtime) - matchPercent(x, name, year, runtime) ||
        score(y) - score(x) ||
        diff(x) - diff(y)
    )
    .slice(0, MAX_RESULTS);
}

const cache = new Map();
const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie") return { streams: [] };
  if (cache.has(id)) return { streams: cache.get(id) };
  try {
    const meta = await getMeta(id);
    if (!meta) return { streams: [] };
    const year = String(meta.year || meta.releaseInfo || "").slice(0, 4);
    const runtime = parseRuntime(meta.runtime);
    console.log(`${meta.name} (${year}) expected runtime: ${runtime || "unknown"}m`);
    const genres = meta.genres || meta.genre;
    console.log("  genres: " + (genres ? genres.join(", ") : "unknown"));
    const videos = await searchYouTube(meta.name, year, runtime, genres);
    console.log(`  -> ${videos.length} YouTube result(s)`);
    const streams = videos.map((v) => ({
      ytId: v.id,
      ...formatStream(v, year, runtime, meta.name),
    }));
    cache.set(id, streams);
    return { streams };
  } catch (e) {
    console.log("Stream handler error:", e.message);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Add-on running on port ${PORT}. Local URL: http://127.0.0.1:${PORT}/manifest.json`);
