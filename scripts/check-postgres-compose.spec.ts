import { describe, expect, it } from "bun:test";

import { validatePostgresCompose } from "./check-postgres-compose";

describe("validatePostgresCompose", () => {
  it("accepts localhost-bound postgres with protected external volume and DB-first limits", () => {
    const violations = validatePostgresCompose({
      services: {
        manticore: {
          mem_limit: "1g",
        },
        postgres: {
          mem_limit: "4g",
          ports: [{ host_ip: "127.0.0.1", published: 5432, target: 5432 }],
        },
      },
      volumes: {
        postgres_data: {
          external: true,
          name: "catapulze-postgres-p0",
        },
      },
    });

    expect(violations).toEqual([]);
  });

  it("rejects public postgres port bindings", () => {
    const violations = validatePostgresCompose({
      services: {
        manticore: {
          mem_limit: "1g",
        },
        postgres: {
          mem_limit: "4g",
          ports: [{ host_ip: "0.0.0.0", published: 5432, target: 5432 }],
        },
      },
      volumes: {
        postgres_data: { external: true, name: "catapulze-postgres-p0" },
      },
    });

    expect(violations).toContainEqual(
      "postgres port 5432 must bind to host_ip 127.0.0.1, found '0.0.0.0'"
    );
  });

  it("rejects read-only manticore.conf bind mounts that break the image entrypoint", () => {
    const violations = validatePostgresCompose({
      services: {
        manticore: {
          mem_limit: "1g",
          volumes: [
            "./tools/manticore/manticore.conf:/etc/manticoresearch/manticore.conf:ro",
          ],
        },
        postgres: {
          mem_limit: "4g",
          ports: [{ host_ip: "127.0.0.1", published: 5432, target: 5432 }],
        },
      },
      volumes: {
        postgres_data: {
          external: true,
          name: "catapulze-postgres-p0",
        },
      },
    });

    expect(violations).toContainEqual(
      "manticore manticore.conf bind mount must not use :ro; the image entrypoint chowns /etc/manticoresearch before searchd starts"
    );
  });

  it("rejects docker compose config bind mounts marked read_only", () => {
    const violations = validatePostgresCompose({
      services: {
        manticore: {
          mem_limit: "1g",
          volumes: [
            {
              bind: { read_only: true },
              source: "/workspace/tools/manticore/manticore.conf",
              target: "/etc/manticoresearch/manticore.conf",
              type: "bind",
            },
          ],
        },
        postgres: {
          mem_limit: "4g",
          ports: [{ host_ip: "127.0.0.1", published: 5432, target: 5432 }],
        },
      },
      volumes: {
        postgres_data: {
          external: true,
          name: "catapulze-postgres-p0",
        },
      },
    });

    expect(violations).toContainEqual(
      "manticore manticore.conf bind mount must not use :ro; the image entrypoint chowns /etc/manticoresearch before searchd starts"
    );
  });

  it("rejects inline postgres volumes and Manticore parity or higher memory", () => {
    const violations = validatePostgresCompose({
      services: {
        manticore: {
          mem_limit: "1g",
        },
        postgres: {
          mem_limit: "1g",
          ports: [{ host_ip: "127.0.0.1", published: 5432, target: 5432 }],
        },
      },
      volumes: {
        postgres_data: {},
      },
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        "volumes.postgres_data must be external: true so compose lifecycle cannot destroy production data",
        "postgres mem_limit (1024m) must exceed manticore mem_limit (1024m)",
      ])
    );
  });
});
