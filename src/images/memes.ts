/**
 * IMAGES/memes — prompt factory for the optional AI meme images.
 *
 * SECURITY INVARIANT (the whole point of this file): an AI image prompt is
 * composed ONLY from the baked style templates below plus a topic string
 * taken from OUR OWN configuration (tuning.content.topics / the author's
 * manual queue). User text must NEVER reach buildMemePrompt — there is no
 * code path from a platform message to this function, and none may ever be
 * added. The topic is still passed through AEGIS prepareUntrusted
 * defensively (config files travel through git and could be tampered with),
 * so fence markers, control characters and hidden unicode die here too.
 *
 * Templates rotate deterministically by styleSeed so the weekly memes never
 * repeat the same look twice in a row. All output is English.
 */

import { prepareUntrusted } from "../aegis/sanitize.js";

/** Shared tail: memes stay text-free — the caption lives in the message. */
const STYLE_SUFFIX = "high detail, single scene, no text, no letters, no captions, no watermark";

/**
 * Baked style templates. "{topic}" is the only interpolation point and it
 * only ever receives a sanitised config topic.
 */
const STYLE_TEMPLATES: readonly string[] = [
  "Ancient Greek black-figure pottery painting of {topic}: engineers in togas gathered around a glowing terminal, terracotta and black glaze, meander border, museum lighting",
  "Weathered marble statue of an AI agent contemplating {topic}, classical Greek sculpture, robes carved with circuit traces, dramatic single museum spotlight",
  "Hand-drawn celestial atlas star chart of {topic} as a constellation, gold ink on deep indigo parchment, the twin stars Castor and Pollux shining brightest",
  "Heroic Renaissance ceiling fresco of microservices as Greek gods orchestrating {topic}, dramatic clouds, gilded frame, sunbeams breaking through",
  "Ancient Roman floor mosaic depicting {topic}, thousands of tiny tesserae tiles, villa atrium setting, slightly damaged with lovingly restored patches",
  "Hellenistic bronze relief of robed engineers carrying server racks toward {topic}, green patina, torchlit temple wall, laurel garlands",
  "Red-figure kylix cup painting of two twin heroes debugging {topic} at a symposium, ancient Greek pottery style, amphorae and scrolls scattered about",
  "Oracle of Delphi divining {topic} from luminous terminal smoke, chiaroscuro oil painting, laurel wreath, awed pilgrims in the shadows",
  "Epic marble frieze of a grand procession delivering {topic} to the Parthenon, robed figures bearing keyboards and scrolls, classical bas-relief",
];

/**
 * Compose one meme image prompt from a baked template + a CONFIG topic.
 * styleSeed picks the template deterministically (any integer, negatives ok)
 * so callers can rotate styles week over week.
 */
export function buildMemePrompt(topic: string, styleSeed: number): string {
  const safeTopic = prepareUntrusted(topic, 120);
  const n = STYLE_TEMPLATES.length;
  const idx = ((Math.floor(styleSeed) % n) + n) % n;
  const template = STYLE_TEMPLATES[idx] ?? STYLE_TEMPLATES[0]!;
  return `${template.replaceAll("{topic}", safeTopic)}, ${STYLE_SUFFIX}`;
}

/**
 * Instruction handed to the text LLM when pairing a caption with a generated
 * meme image (the image itself is text-free by design).
 */
export const MEME_CAPTION_HINT =
  "Write ONE short, dry English caption for this image — a single sentence, " +
  "no hashtags, no emoji pile-ups. The joke lands in the caption; the image stays text-free.";
