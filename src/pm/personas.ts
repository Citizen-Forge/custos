/**
 * Human names and avatars for agents.
 *
 * A board covered in "Generalist Engineer" and "Simulation Architect" is
 * hard to read at a glance: the eye can't tell two of them apart on a card,
 * in a comment thread, or in the activity feed. Names are what make a team
 * legible, and this is a tool for watching a team work.
 *
 * The list is deliberately broad across genders and cultural backgrounds --
 * a roster that reads as one demographic would be a strange thing to
 * generate by default, and the names cost nothing to pick well.
 */

export interface Persona {
  name: string;
  /** Two-letter monogram used when no image is available -- avatars here are
   * initials on a generated colour, not fetched images, so nothing renders
   * a remote request into the UI. */
  initials: string;
  /** Deterministic hue (0-359) for the avatar background. */
  hue: number;
}

const NAMES = [
  "Amara Okafor",
  "Priya Raghunathan",
  "Diego Alvarez",
  "Mei-Ling Chen",
  "Yusuf Demir",
  "Sofia Almeida",
  "Kwame Mensah",
  "Hana Kobayashi",
  "Rohan Kapoor",
  "Elena Petrova",
  "Tomás Ferreira",
  "Aisha Rahman",
  "Nikolai Volkov",
  "Grace Adeyemi",
  "Ravi Chandra",
  "Lucia Moreau",
  "Omar Haddad",
  "Ingrid Lindqvist",
  "Jamal Carter",
  "Sun-Hee Park",
  "Marco Bianchi",
  "Fatima Zahra",
  "Dmitri Sokolov",
  "Chiamaka Eze",
  "Leila Nasser",
  "Andrés Vargas",
  "Noor Siddiqui",
  "Kenji Watanabe",
  "Zoe Karras",
  "Thabo Nkosi",
] as const;

function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** Stable hash so the same name always gets the same colour, across
 * restarts and across the two clients. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export function personaFor(name: string): Persona {
  return { name, initials: initialsOf(name), hue: hashString(name) % 360 };
}

/**
 * Picks a name not already in use. Falls back to appending a discriminator
 * once the list is exhausted rather than repeating a name -- two engineers
 * called Amara on the same board would defeat the point.
 */
export function pickPersonaName(taken: Iterable<string>): string {
  const used = new Set(taken);
  const free = NAMES.filter((name) => !used.has(name));
  if (free.length) return free[Math.floor(Math.random() * free.length)];

  for (let suffix = 2; ; suffix++) {
    for (const name of NAMES) {
      const candidate = `${name} (${suffix})`;
      if (!used.has(candidate)) return candidate;
    }
  }
}
