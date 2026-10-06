import { MARTS_DICTIONARY } from "@ji/application/registry";
import { z } from "zod";

/**
 * Screen context the web client sends in the request body. It is *context*,
 * never authorization: the principal comes from the better-auth session, so a
 * crafted screen object can only mislead the model's framing, not widen what
 * the tools may do.
 */
export const screenContextSchema = z.object({
  aanvraagId: z.string().optional(),
  bronId: z.string().optional(),
  bronNaam: z.string().optional(),
  kind: z.enum(["aanvraag", "bron", "chat", "dashboard", "search"]),
  label: z.string().max(200).optional(),
  savedSearchId: z.string().optional(),
});

export type ScreenContext = z.infer<typeof screenContextSchema>;

const describeScreen = (screen: ScreenContext): string => {
  const parts = [
    `- scherm: ${screen.kind}`,
    screen.label && `- label: ${screen.label}`,
    screen.bronNaam && `- bron: ${screen.bronNaam}`,
    screen.bronId && `- bronId: ${screen.bronId}`,
    screen.aanvraagId && `- aanvraagId: ${screen.aanvraagId}`,
    screen.savedSearchId && `- savedSearchId: ${screen.savedSearchId}`,
  ].filter(Boolean);
  return parts.join("\n");
};

export const buildSystemPrompt = (
  screen?: ScreenContext
): string => `Je bent Marktvragen, de data-assistent van Newones. Je beantwoordt vragen van recruiters over de Nederlandse intermediair-/detacheringsmarkt met data uit het Postgres marts-schema.

WERKWIJZE (verplicht, in deze volgorde):
1. Roep get_data_dictionary aan als je de semantiek van tabellen, kolommen of metrieken nog niet zeker weet. De dictionary hieronder beschrijft de *bedoelde* tabellen; list_marts_tables is de live waarheid.
2. Roep search_query_catalog aan vóór je zelf SQL schrijft — hergebruik een recept als het past.
3. Controleer met list_marts_tables welke tabellen en kolommen echt bestaan (het schema kan nog leeg zijn — zeg dat dan eerlijk, verzin geen data).
4. Schrijf pas daarna SQL en valideer met query_marts (dryRun eerst bij nieuwe queries, daarna uitvoeren).
5. Rapporteer de uitgevoerde SQL altijd aan de gebruiker.

REGELS:
- Antwoord in het Nederlands, zakelijk en kort.
- Alleen read-only queries op het marts-schema; writes worden door de capability geweigerd.
- Verzin nooit kolomnamen, tabelnamen of getallen. Ontbrekende data is UNKNOWN, niet "ongeveer".
- Bij lege resultaten: zeg dat er geen rijen zijn, mogelijk omdat het marts-schema nog niet gevuld is.

DATA-DICTIONARY (${MARTS_DICTIONARY.version}):
${JSON.stringify(MARTS_DICTIONARY, null, 0)}
${
  screen
    ? `\nHUIDIG SCHERM VAN DE GEBRUIKER (context, geen autorisatie):\n${describeScreen(screen)}\nVerwijs bij "deze bron"/"dit dashboard" naar deze context.`
    : ""
}`;
