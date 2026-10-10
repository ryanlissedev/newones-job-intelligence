import { alliander } from "./alliander";
import { asml } from "./asml";
import { bam } from "./bam";
import { bijOranje } from "./bij-oranje";
import { bluetrail } from "./bluetrail";
import { circle8 } from "./circle8";
import { ctm } from "./ctm";
import { datajobs } from "./datajobs";
import type { SourceDefinition } from "./definition";
import { eneco } from "./eneco";
import { enexis } from "./enexis";
import { essent } from "./essent";
import { flinter } from "./flinter";
import { freelancerNl } from "./freelancer-nl";
import { gasunie } from "./gasunie";
import { haert } from "./haert";
import { harveynash } from "./harveynash";
import { hays } from "./hays";
import { heijmans } from "./heijmans";
import { hero } from "./hero";
import { indeed } from "./indeed";
import { inhuurdesk } from "./inhuurdesk";
import { intermediair } from "./intermediair";
import { jobbird } from "./jobbird";
import { linkedin } from "./linkedin";
import { mercell } from "./mercell";
import { needstaffing } from "./needstaffing";
import { ns } from "./ns";
import { onefellow } from "./onefellow";
import { opdrachtoverheid } from "./opdrachtoverheid";
import { planetInterim } from "./planet-interim";
import { proAct } from "./pro-act";
import { prorail } from "./prorail";
import { prounity } from "./prounity";
import { rabobank } from "./rabobank";
import { randstad } from "./randstad";
import { rijkswaterstaat } from "./rijkswaterstaat";
import { stedin } from "./stedin";
import { striive } from "./striive";
import { tbi } from "./tbi";
import { techniekwerkt } from "./techniekwerkt";
import { tenderned } from "./tenderned";
import { tenmonks } from "./tenmonks";
import { tennet } from "./tennet";
import { unica } from "./unica";
import { vattenfall } from "./vattenfall";
import { volkerwessels } from "./volkerwessels";
import { werkNl } from "./werk-nl";
import { werkenVoorNederland } from "./werken-voor-nederland";
import { zzpOpdrachten } from "./zzp-opdrachten";

export type {
  CreateSourceConnectorInput,
  SourceDefinition,
} from "./definition";
export { resolveTenderNedTestImportDays } from "./tenderned";

/** Registry of every ingestable bron. Adding a source = one file in this folder + one line here. */
export const SOURCES = {
  alliander,
  asml,
  bam,
  "bij-oranje": bijOranje,
  bluetrail,
  circle8,
  ctm,
  datajobs,
  eneco,
  enexis,
  essent,
  flinter,
  "freelancer-nl": freelancerNl,
  gasunie,
  haert,
  harveynash,
  hays,
  heijmans,
  hero,
  indeed,
  inhuurdesk,
  intermediair,
  jobbird,
  linkedin,
  mercell,
  needstaffing,
  ns,
  onefellow,
  opdrachtoverheid,
  "planet-interim": planetInterim,
  "pro-act": proAct,
  prorail,
  prounity,
  rabobank,
  randstad,
  rijkswaterstaat,
  stedin,
  striive,
  tbi,
  techniekwerkt,
  tenderned,
  tenmonks,
  tennet,
  unica,
  vattenfall,
  volkerwessels,
  "werk-nl": werkNl,
  "werken-voor-nederland": werkenVoorNederland,
  "zzp-opdrachten": zzpOpdrachten,
} as const satisfies Record<string, SourceDefinition>;

export type SupportedBronSlug = keyof typeof SOURCES;

export const isSupportedBronSlug = (
  value: string
): value is SupportedBronSlug => Object.hasOwn(SOURCES, value);

/** Alphabetical so `z.enum` shapes and CLI help stay stable across additions. */
export const SUPPORTED_BRON_SLUGS: readonly SupportedBronSlug[] = Object.keys(
  SOURCES
)
  .filter(isSupportedBronSlug)
  .toSorted();

const normaliseNaam = (naam: string): string => naam.trim().toLowerCase();

/** `record.naam` is the only source-identifying field on a bron row (no slug column yet),
 * so match it case-insensitively against each definition's own `naam`. */
export const findSourceByNaam = <Source extends Pick<SourceDefinition, "naam">>(
  sources: readonly Source[],
  naam: string
): Source | undefined => {
  const wanted = normaliseNaam(naam);
  return sources.find((source) => normaliseNaam(source.naam) === wanted);
};

export const resolveSourceByNaam = (
  naam: string
): (typeof SOURCES)[SupportedBronSlug] | undefined =>
  findSourceByNaam(Object.values(SOURCES), naam);
