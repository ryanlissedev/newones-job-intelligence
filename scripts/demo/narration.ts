/** Dutch product-tour narration for the JI feature demo reel. */

export const DEMO_VOICE_ID = "82601fe034ea4d18994b5211acff8d03";
// Sharon (Dutch), HeyGen starfish engine.

export const DEMO_NARRATION_NL = `Welkom bij Catapulze Job Intelligence. Dit is een korte producttour door de live omgeving.

We beginnen op het command center: één plek om opdrachten te vinden vóór de rest.

Na het inloggen openen we Zoeken. Met Boolean-logica, bijvoorbeeld java OR devops, zie je direct resultaataantallen en facetten.

Één resultaat openen toont titel, details en herkomst. Geen giswerk over waar de data vandaan komt.

Daarna de bronmonitor: KPI's en brongezondheid voor operators. Scrape-runs laten zien dat ingest live loopt.

Tot slot het dashboard en uitloggen. Zo werkt Catapulze Job Intelligence end-to-end.`;

/** Cue times (seconds) aligned to the HeyGen Sharon nl take. */
export const DEMO_NARRATION_CUES = [
  { at: 0, label: "home" },
  { at: 6.6, label: "login" },
  { at: 12.3, label: "jobs" },
  { at: 23.5, label: "detail" },
  { at: 31.8, label: "bronnen" },
  { at: 36.5, label: "runs" },
  { at: 39.6, label: "dashboard" },
  { at: 42.3, label: "signout" },
] as const;
