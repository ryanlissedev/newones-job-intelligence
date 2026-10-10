import type { AanvraagId, BronId } from "@ji/domain";

import type {
  CurateStore,
  StoredAanvraag,
  StoredAanvraagVersie,
  StoredDedupGroep,
  StoredOutboxEvent,
} from "./curate";

export class InMemoryCurateStore implements CurateStore {
  readonly aanvragen: StoredAanvraag[] = [];
  readonly dedupGroepen: StoredDedupGroep[] = [];
  readonly outboxEvents: StoredOutboxEvent[] = [];
  readonly versies: StoredAanvraagVersie[] = [];

  findAanvraagByIdentity(
    bronId: BronId,
    bronReferentie: string
  ): Promise<StoredAanvraag | null> {
    const match = this.aanvragen.find(
      (row) => row.bronId === bronId && row.bronReferentie === bronReferentie
    );
    return Promise.resolve(match ? structuredClone(match) : null);
  }

  /** Single-threaded, so find-then-push is already race-free here. */
  ensureDedupGroep(input: { dedupKey: string }): Promise<StoredDedupGroep> {
    const match = this.dedupGroepen.find(
      (row) => row.dedupKey === input.dedupKey
    );
    if (match) {
      return Promise.resolve(structuredClone(match));
    }
    const row: StoredDedupGroep = {
      dedupGroepId: crypto.randomUUID(),
      dedupKey: input.dedupKey,
      handmatigBevestigd: false,
      status: "reviewable",
    };
    this.dedupGroepen.push(row);
    return Promise.resolve(structuredClone(row));
  }

  findDedupGroepByKey(dedupKey: string): Promise<StoredDedupGroep | null> {
    const match = this.dedupGroepen.find((row) => row.dedupKey === dedupKey);
    return Promise.resolve(match ? structuredClone(match) : null);
  }

  insertAanvraag(
    input: Omit<StoredAanvraag, "aanvraagId">
  ): Promise<StoredAanvraag> {
    const row: StoredAanvraag = {
      ...structuredClone(input),
      aanvraagId: crypto.randomUUID(),
    };
    this.aanvragen.push(row);
    return Promise.resolve(structuredClone(row));
  }

  insertOutboxEvent(
    input: Omit<StoredOutboxEvent, "id">
  ): Promise<StoredOutboxEvent> {
    const row: StoredOutboxEvent = {
      ...structuredClone(input),
      id: crypto.randomUUID(),
    };
    this.outboxEvents.push(row);
    return Promise.resolve(structuredClone(row));
  }

  insertVersie(
    input: Omit<StoredAanvraagVersie, "versieId">
  ): Promise<StoredAanvraagVersie> {
    const row: StoredAanvraagVersie = {
      ...structuredClone(input),
      versieId: crypto.randomUUID(),
    };
    this.versies.push(row);
    return Promise.resolve(structuredClone(row));
  }

  linkAanvraagToDedupGroep(
    aanvraagId: AanvraagId,
    dedupGroepId: string
  ): Promise<void> {
    const row = this.aanvragen.find((entry) => entry.aanvraagId === aanvraagId);
    if (!row) {
      throw new Error("aanvraag not found");
    }
    row.dedupGroepId = dedupGroepId;
    return Promise.resolve();
  }

  splitDedupGroep(dedupGroepId: string): Promise<void> {
    for (const row of this.aanvragen) {
      if (row.dedupGroepId === dedupGroepId) {
        row.dedupGroepId = null;
      }
    }
    const index = this.dedupGroepen.findIndex(
      (row) => row.dedupGroepId === dedupGroepId
    );
    if (index !== -1) {
      this.dedupGroepen.splice(index, 1);
    }
    return Promise.resolve();
  }

  updateAanvraag(
    aanvraagId: AanvraagId,
    patch: Partial<StoredAanvraag>
  ): Promise<StoredAanvraag> {
    const index = this.aanvragen.findIndex(
      (row) => row.aanvraagId === aanvraagId
    );
    const current = this.aanvragen[index];
    if (!current) {
      throw new Error("aanvraag not found");
    }
    const merged: StoredAanvraag = {
      ...current,
      ...structuredClone(patch),
      aanvraagId,
    };
    this.aanvragen[index] = merged;
    return Promise.resolve(structuredClone(merged));
  }

  /**
   * Models Postgres transaction semantics: a throw inside `fn` restores
   * every table to its pre-transaction state, so a failure after the versie
   * write leaves nothing (RJC-399).
   */
  async withTransaction<T>(fn: (store: CurateStore) => Promise<T>): Promise<T> {
    const backup = structuredClone({
      aanvragen: this.aanvragen,
      dedupGroepen: this.dedupGroepen,
      outboxEvents: this.outboxEvents,
      versies: this.versies,
    });
    try {
      return await fn(this);
    } catch (error) {
      this.aanvragen.splice(0, this.aanvragen.length, ...backup.aanvragen);
      this.dedupGroepen.splice(
        0,
        this.dedupGroepen.length,
        ...backup.dedupGroepen
      );
      this.outboxEvents.splice(
        0,
        this.outboxEvents.length,
        ...backup.outboxEvents
      );
      this.versies.splice(0, this.versies.length, ...backup.versies);
      throw error;
    }
  }

  closeOpenVersie(aanvraagId: AanvraagId, closedAt: Date): Promise<void> {
    for (const versie of this.versies) {
      if (versie.aanvraagId === aanvraagId && versie.geldigTot === null) {
        versie.geldigTot = closedAt;
      }
    }
    return Promise.resolve();
  }
}
