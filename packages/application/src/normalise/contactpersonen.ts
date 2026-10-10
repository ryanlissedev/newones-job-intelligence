import type { SourceContact } from "@ji/connectors";
import type { Contactpersoon } from "@ji/domain";

import { contactpersoonBeleidVoor } from "../sources/contactpersoon-beleid";
import { field } from "./types";
import type { NormalisedField } from "./types";

/** CTP-610: maps one source-published contact (a `SourceContact`, or a
 * schema.org `ContactPoint`-shaped node) to the canonical domain shape. The
 * pipeline-owned art. 14 fields start null — a source can never set them.
 * A contact needs a reachable channel (email/telefoon) or naam+rol —
 * a bare name could be boilerplate or an org name, never a person. */
export const toContactpersoon = (contact: {
  email?: string | null;
  naam?: string | null;
  rol?: string | null;
  telefoon?: string | null;
}): Contactpersoon | null => {
  const naam = contact.naam?.trim() || null;
  const email = contact.email?.trim() || null;
  const telefoon = contact.telefoon?.trim() || null;
  const rol = contact.rol?.trim() || null;
  if (!(email || telefoon || (naam && rol))) {
    return null;
  }
  return {
    email,
    geinformeerdOp: null,
    naam,
    notificatieKanaal: null,
    rol,
    telefoon,
  };
};

const contactKey = (contact: Contactpersoon): string =>
  `${contact.naam ?? ""}|${contact.email?.toLowerCase() ?? ""}|${contact.telefoon ?? ""}`;

/** CTP-610: pushes one mapped contact onto the list unless (naam, email,
 * telefoon) already appears — the shared dedupe rule for every merge path.
 * Telefoon is part of the key: two channel-only contacts that publish
 * different phone numbers are different reachable contacts, not dupes. */
export const pushUniqueContactpersoon = (
  list: Contactpersoon[],
  contact: Contactpersoon | null
): void => {
  if (
    contact &&
    !list.some((entry) => contactKey(entry) === contactKey(contact))
  ) {
    list.push(contact);
  }
};

/** CTP-610: `geinformeerdOp`/`notificatieKanaal` are pipeline-owned art. 14
 * fields — a source republish always re-emits them null, so a wholesale
 * `contactpersonen` overwrite on curate would erase the disclosure trail.
 * On update, carry the prior pipeline values forward for contacts that keep
 * the same (naam, email, telefoon) identity; contacts the source dropped
 * fall away with the rest of the list. */
export const mergeContactpersoonPipelineVelden = (
  previous: readonly Contactpersoon[],
  next: readonly Contactpersoon[]
): Contactpersoon[] => {
  const byKey = new Map(
    previous.map((contact) => [contactKey(contact), contact])
  );
  return next.map((contact) => {
    const prior = byKey.get(contactKey(contact));
    if (!prior) {
      return contact;
    }
    return {
      ...contact,
      geinformeerdOp: contact.geinformeerdOp ?? prior.geinformeerdOp,
      notificatieKanaal: contact.notificatieKanaal ?? prior.notificatieKanaal,
    };
  });
};

/** CTP-610: resolves a connector's `contactpersonen` list into a draft field.
 * Applies the bron's `contactpersoon_beleid.extractie`, maps to
 * `Contactpersoon`, drops empty entries and dedupes on (naam, email, telefoon).
 * Returns null when the bron may not store contacts or nothing remains —
 * callers then simply omit the draft field. */
export const toDraftContactpersonen = (
  slug: string,
  contacts: readonly SourceContact[] | null | undefined,
  parserVersion: string,
  sourcePath: string
): NormalisedField<Contactpersoon[]> | null => {
  if (!contactpersoonBeleidVoor(slug).extractie || !contacts?.length) {
    return null;
  }
  const contactpersonen: Contactpersoon[] = [];
  for (const contact of contacts) {
    pushUniqueContactpersoon(contactpersonen, toContactpersoon(contact));
  }
  return contactpersonen.length > 0
    ? field(contactpersonen, parserVersion, sourcePath)
    : null;
};
