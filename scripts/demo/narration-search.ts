/** Dutch narration for the search-methods + filters overview reel. */

export const SEARCH_TOUR_VOICE_ID = "82601fe034ea4d18994b5211acff8d03";

export const SEARCH_TOUR_NARRATION_NL = `Welkom bij Catapulze Job Intelligence. We lopen de zoeklaag door: Boolean, filters en archief.

Eerst Boolean OR met een frase: Azure OR Power BI, zonder juniorrollen.

Daarna AND: Azure én data. Je ziet meteen hoeveel opdrachten matchen.

Nu filters. We kiezen een bron, een contracttype, publicatie in de laatste dertig dagen, en eventueel een minimumtarief. Actieve filters verschijnen als chips.

Sorteren op nieuwste eerst. En we zetten Ook in archief zoeken aan, zodat historische hits meetellen.

Tot slot wissen we alles met één klik, en openen we één resultaat met herkomst. Zo combineer je zoekmethodes en filters in Catapulze.`;

export const SEARCH_TOUR_CUES = [
  { at: 0, label: "intro" },
  { at: 7.5, label: "boolean-or" },
  { at: 14.2, label: "boolean-and" },
  { at: 20.4, label: "filters" },
  { at: 33.4, label: "sort" },
  { at: 35.9, label: "archive" },
  { at: 42.2, label: "clear-detail" },
] as const;
