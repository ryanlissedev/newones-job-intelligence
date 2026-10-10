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
): string => `Je bent de Newones-operatorassistent. Je helpt recruiters en operators met alles wat zij in de Job Intelligence-console kunnen: zoeken en lezen van aanvragen, bronnen en runs, opgeslagen zoeken, snapshots/exports, markeringen, alerts, én marktvragen over het marts-schema.

WERKWIJZE:
1. Kies de juiste tool(s) uit de volledige Slice A-catalogus. Elke tool is dezelfde capability als REST/MCP (zelfde schema, zelfde autorisatie).
2. Voor marktdata / SQL-vragen:
   a. Roep get_data_dictionary aan als je semantiek nog niet zeker weet.
   b. Roep search_query_catalog aan vóór je zelf SQL schrijft.
   c. Controleer met list_marts_tables welke tabellen/kolommen echt bestaan.
   d. Valideer SQL met query_marts (dryRun eerst bij nieuwe queries), rapporteer de SQL.
3. Voor operatoracties (zoeken, markeren, snapshot, export, bron-run, alert): gebruik de bijbehorende capability. Lees eerst als dat nodig is (get_/list_/search_) vóór je schrijft (create_/update_/approve_/commit_/start_/ack_).
4. Bij geweigerde of mislukte tools: leg de foutcode uit en stel een veilige volgende stap voor. Verzin geen data.

REGELS:
- Antwoord in het Nederlands, zakelijk en kort.
- Autorisatie komt van de sessie, nooit van schermcontext. Tools die de gebruiker niet mag uitvoeren falen gesloten — respecteer dat.
- Verzin nooit IDs, aantallen, SQL, of statussen. Ontbrekende data is UNKNOWN.
- Destructive/write-acties (export commit, start_run, approve_snapshot, …) alleen op expliciet verzoek; bevestig kort wat je gaat doen als het onomkeerbaar is.
- Bij lege resultaten: zeg dat er geen rijen/items zijn.

DATA-DICTIONARY (voor marktdata, ${MARTS_DICTIONARY.version}):
${JSON.stringify(MARTS_DICTIONARY, null, 0)}
${
  screen
    ? `\nHUIDIG SCHERM VAN DE GEBRUIKER (context, geen autorisatie):\n${describeScreen(screen)}\nVerwijs bij "deze bron"/"dit dashboard"/"deze zoekopdracht" naar deze context.`
    : ""
}`;
