/**
 * Static NL geocoder for /jobs map view (CTP-509).
 * Inspired by Motian province centroids — original table, Motian untouched.
 */

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
  readonly label: string;
}

/** Rough Netherlands bounding box used to project markers onto the SVG map. */
export const NL_BOUNDS = {
  east: 7.25,
  north: 53.7,
  south: 50.75,
  west: 3.2,
} as const;

const PROVINCE_CENTROIDS = {
  drenthe: { label: "Drenthe", lat: 52.9928, lng: 6.5624 },
  flevoland: { label: "Flevoland", lat: 52.5185, lng: 5.4714 },
  friesland: { label: "Friesland", lat: 53.2012, lng: 5.7999 },
  fryslan: { label: "Friesland", lat: 53.2012, lng: 5.7999 },
  gelderland: { label: "Gelderland", lat: 51.9851, lng: 5.8987 },
  groningen: { label: "Groningen", lat: 53.2194, lng: 6.5665 },
  limburg: { label: "Limburg", lat: 50.8514, lng: 5.6909 },
  "noord-brabant": { label: "Noord-Brabant", lat: 51.6978, lng: 5.3037 },
  "noord-holland": { label: "Noord-Holland", lat: 52.3874, lng: 4.6462 },
  overijssel: { label: "Overijssel", lat: 52.5168, lng: 6.083 },
  utrecht: { label: "Utrecht", lat: 52.0907, lng: 5.1214 },
  zeeland: { label: "Zeeland", lat: 51.4988, lng: 3.61 },
  "zuid-holland": { label: "Zuid-Holland", lat: 52.0705, lng: 4.3007 },
};

const CITY_POINTS = {
  alkmaar: { label: "Alkmaar", lat: 52.6324, lng: 4.7534 },
  almere: { label: "Almere", lat: 52.3508, lng: 5.2647 },
  amersfoort: { label: "Amersfoort", lat: 52.1561, lng: 5.3878 },
  amsterdam: { label: "Amsterdam", lat: 52.3676, lng: 4.9041 },
  apeldoorn: { label: "Apeldoorn", lat: 52.2112, lng: 5.9699 },
  arnhem: { label: "Arnhem", lat: 51.9851, lng: 5.8987 },
  breda: { label: "Breda", lat: 51.5719, lng: 4.7683 },
  delft: { label: "Delft", lat: 52.0116, lng: 4.3571 },
  "den bosch": { label: "'s-Hertogenbosch", lat: 51.6978, lng: 5.3037 },
  "den haag": { label: "Den Haag", lat: 52.0705, lng: 4.3007 },
  deventer: { label: "Deventer", lat: 52.2551, lng: 6.1639 },
  dordrecht: { label: "Dordrecht", lat: 51.8133, lng: 4.6901 },
  eindhoven: { label: "Eindhoven", lat: 51.4416, lng: 5.4697 },
  enschede: { label: "Enschede", lat: 52.2215, lng: 6.8937 },
  groningen: { label: "Groningen", lat: 53.2194, lng: 6.5665 },
  haarlem: { label: "Haarlem", lat: 52.3874, lng: 4.6462 },
  heerlen: { label: "Heerlen", lat: 50.8882, lng: 5.9795 },
  hilversum: { label: "Hilversum", lat: 52.2233, lng: 5.1764 },
  leeuwarden: { label: "Leeuwarden", lat: 53.2012, lng: 5.7999 },
  leiden: { label: "Leiden", lat: 52.1601, lng: 4.497 },
  maastricht: { label: "Maastricht", lat: 50.8514, lng: 5.6909 },
  nederland: { label: "Nederland", lat: 52.1326, lng: 5.2913 },
  netherlands: { label: "Nederland", lat: 52.1326, lng: 5.2913 },
  nijmegen: { label: "Nijmegen", lat: 51.8126, lng: 5.8372 },
  remote: { label: "Remote", lat: 52.1326, lng: 5.2913 },
  rotterdam: { label: "Rotterdam", lat: 51.9225, lng: 4.4792 },
  "s-gravenhage": { label: "Den Haag", lat: 52.0705, lng: 4.3007 },
  "s-hertogenbosch": { label: "'s-Hertogenbosch", lat: 51.6978, lng: 5.3037 },
  thehague: { label: "Den Haag", lat: 52.0705, lng: 4.3007 },
  tilburg: { label: "Tilburg", lat: 51.5555, lng: 5.0913 },
  utrecht: { label: "Utrecht", lat: 52.0907, lng: 5.1214 },
  venlo: { label: "Venlo", lat: 51.3704, lng: 6.1724 },
  zoetermeer: { label: "Zoetermeer", lat: 52.0607, lng: 4.494 },
  zwolle: { label: "Zwolle", lat: 52.5168, lng: 6.083 },
  zwollecentrum: { label: "Zwolle", lat: 52.5168, lng: 6.083 },
};

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036F]/gu, "")
    .toLocaleLowerCase("nl-NL")
    .replaceAll(/[^a-z0-9\s-]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

export interface MapPercentPosition {
  readonly left: number;
  readonly top: number;
}

export const projectToMapPercent = (point: GeoPoint): MapPercentPosition => {
  const left =
    ((point.lng - NL_BOUNDS.west) / (NL_BOUNDS.east - NL_BOUNDS.west)) * 100;
  const top =
    ((NL_BOUNDS.north - point.lat) / (NL_BOUNDS.north - NL_BOUNDS.south)) * 100;
  return {
    left: Math.min(98, Math.max(2, left)),
    top: Math.min(98, Math.max(2, top)),
  };
};

export const geocodeNlLocation = (location: string | null): GeoPoint | null => {
  if (location === null || location.trim() === "") {
    return null;
  }
  const normalized = normalize(location);
  if (normalized === "") {
    return null;
  }

  for (const [key, point] of Object.entries(CITY_POINTS)) {
    if (normalized === key || normalized.includes(key)) {
      return point;
    }
  }
  for (const [key, point] of Object.entries(PROVINCE_CENTROIDS)) {
    if (normalized === key || normalized.includes(key)) {
      return point;
    }
  }
  return null;
};
