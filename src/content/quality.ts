/**
 * Release-name parsing. Selection quality matters more here than in a normal streaming
 * addon: a viewer cannot skip a bad pick, they just watch it, so the choice has to be
 * right the first time.
 */
export interface ReleaseInfo {
  resolution: number;
  hdr: boolean;
  /** Encodes that need far more CPU when the software encoder is in play. */
  hevc: boolean;
  remux: boolean;
  cam: boolean;
  /** Best language signal available from the release name and selected filename. */
  language: ReleaseLanguage;
  sizeBytes: number;
  seeders: number;
}

export type ReleaseLanguage = "english" | "multi" | "foreign" | "unknown";

const RESOLUTIONS: [RegExp, number][] = [
  [/\b(2160p|4k|uhd)\b/i, 2160],
  [/\b1440p\b/i, 1440],
  [/\b1080p\b/i, 1080],
  [/\b720p\b/i, 720],
  [/\b(480p|576p)\b/i, 480],
  [/\b360p\b/i, 360],
];

/** Telesync and cam rips are unwatchable; never air one whatever else it scores. */
const CAM = /\b(cam|camrip|hdcam|ts|telesync|telecine|tc|hdts|screener|scr)\b/i;

const ENGLISH = /\b(english|eng)\b/i;
const MULTI_AUDIO = /\b(multi(?:[ ._-]?audio)?|dual[ ._-]?audio)\b/i;
/**
 * Explicit dub/language tags commonly used in torrent names. Unknown is deliberately
 * not treated as English: most English releases carry no language tag at all, so it is
 * a useful fallback, while a positively foreign-tagged release should lose the ranking.
 */
const FOREIGN_LANGUAGE = new RegExp(
  String.raw`\b(` +
    [
      "truefrench", "french", "fre", "fra",
      "italian", "ita",
      "german", "ger", "deu",
      "spanish", "spa", "castellano", "latino",
      "portuguese", "por", "brazilian",
      "russian", "rus", "ukrainian", "ukr",
      "polish", "pol", "dutch",
      "swedish", "swe", "danish", "dan", "norwegian", "nor", "finnish", "fin",
      "czech", "cze", "hungarian", "hun", "romanian", "rum", "greek", "gre",
      "turkish", "tur", "arabic", "ara", "hebrew", "heb",
      "hindi", "tamil", "telugu", "malayalam", "kannada", "bengali", "punjabi",
      "japanese", "jpn", "korean", "kor", "mandarin", "cantonese", "chinese",
      "thai", "tha", "vietnamese", "vie", "indonesian",
    ].join("|") +
    String.raw`)\b`,
  "i",
);

export function detectReleaseLanguage(title: string): ReleaseLanguage {
  if (ENGLISH.test(title)) return "english";
  if (MULTI_AUDIO.test(title)) return "multi";
  if (FOREIGN_LANGUAGE.test(title)) return "foreign";
  return "unknown";
}

/** Combines a torrent-level tag with the more specific filename-level signal. */
export function combineReleaseLanguage(
  release: ReleaseLanguage,
  file: ReleaseLanguage,
): ReleaseLanguage {
  if (release === "english" || file === "english") return "english";
  if (release === "multi" || file === "multi") return "multi";
  if (release === "foreign" || file === "foreign") return "foreign";
  return "unknown";
}

export function parseRelease(title: string, sizeBytes = 0, seeders = 0): ReleaseInfo {
  const resolution = RESOLUTIONS.find(([re]) => re.test(title))?.[1] ?? 0;
  return {
    resolution,
    hdr: /\b(hdr|hdr10|dolby.?vision|\bdv\b)\b/i.test(title),
    hevc: /\b(hevc|x265|h\.?265)\b/i.test(title),
    remux: /\bremux\b/i.test(title),
    cam: CAM.test(title),
    language: detectReleaseLanguage(title),
    sizeBytes: sizeBytes || parseSize(title),
    seeders: seeders || parseSeeders(title),
  };
}

/** Torrentio embeds "💾 12.4 GB" in the stream title. */
export function parseSize(title: string): number {
  const match = /([\d.]+)\s*(TB|GB|MB)/i.exec(title);
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === "TB" ? 1e12 : unit === "GB" ? 1e9 : 1e6;
  return Math.round(value * multiplier);
}

export function parseSeeders(title: string): number {
  const match = /👤\s*(\d+)/.exec(title);
  return match ? Number(match[1]) : 0;
}

export interface SelectionPrefs {
  /** Preferred resolutions, best first. */
  qualityPreference: string[];
  /** Skip releases larger than this; huge remuxes waste bandwidth for no visible gain. */
  maxSizeBytes?: number;
  /** Avoid HEVC when the software encoder would struggle to decode it in real time. */
  avoidHevc?: boolean;
}

/**
 * Scores a release. Higher is better; negative means never air it.
 *
 * Resolution dominates, then everything else acts as a tie-break, because for a
 * continuous feed reliability beats squeezing out the last increment of quality.
 */
export function scoreRelease(info: ReleaseInfo, prefs: SelectionPrefs): number {
  if (info.cam) return -1;
  if (prefs.maxSizeBytes && info.sizeBytes > prefs.maxSizeBytes) return -1;

  const wanted = prefs.qualityPreference.map(toResolution).filter((r) => r > 0);
  const rank = wanted.indexOf(info.resolution);

  // An unlisted resolution is still playable, just ranked below everything asked for.
  let score = rank >= 0 ? (wanted.length - rank) * 1000 : 100;

  // Language outranks picture quality. A 720p English release is preferable to a
  // pristine foreign-only release when this is a lean-back linear channel.
  score += {
    english: 30_000,
    multi: 20_000,
    unknown: 10_000,
    foreign: 0,
  }[info.language];

  // Remuxes are enormous and bring nothing once we re-encode to a fixed bitrate.
  if (info.remux) score -= 400;
  if (prefs.avoidHevc && info.hevc) score -= 300;
  // HDR tonemaps poorly without explicit handling and can look washed out.
  if (info.hdr) score -= 150;

  score += Math.min(info.seeders, 200) / 2;
  return score;
}

function toResolution(label: string): number {
  const match = /(\d+)/.exec(label);
  if (!match) return 0;
  const n = Number(match[1]);
  return n === 4 ? 2160 : n;
}

export function pickBest<T>(
  items: T[],
  describe: (item: T) => ReleaseInfo,
  prefs: SelectionPrefs,
): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const score = scoreRelease(describe(item), prefs);
    if (score >= 0 && score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}
