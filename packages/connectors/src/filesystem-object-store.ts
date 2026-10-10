import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { ObjectStore, StoredObject } from "./object-store";

const METADATA_SUFFIX = ".ji-meta.json";

interface StoredMetadata {
  contentType: StoredObject["contentType"];
  expiresAt: string;
}

const resolveWithinRoot = (rootDir: string, objectPath: string): string => {
  const normalizedRoot = path.resolve(rootDir);
  const resolved = path.resolve(normalizedRoot, objectPath);
  if (
    resolved !== normalizedRoot &&
    !resolved.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error(`Object path escapes store root: ${objectPath}`);
  }
  return resolved;
};

const metadataPathFor = (filePath: string): string =>
  `${filePath}${METADATA_SUFFIX}`;

/** Local on-box raw store for dev smoke runs; production uses S3-compatible storage. */
export class FilesystemObjectStore implements ObjectStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async put(object: StoredObject): Promise<void> {
    const filePath = resolveWithinRoot(this.rootDir, object.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, object.body);
    const metadata: StoredMetadata = {
      contentType: object.contentType,
      expiresAt: object.expiresAt.toISOString(),
    };
    await writeFile(
      metadataPathFor(filePath),
      JSON.stringify(metadata),
      "utf-8"
    );
  }

  async get(objectPath: string): Promise<StoredObject | null> {
    const filePath = resolveWithinRoot(this.rootDir, objectPath);
    try {
      const [body, metadataRaw] = await Promise.all([
        readFile(filePath),
        readFile(metadataPathFor(filePath), "utf-8"),
      ]);
      // SAFETY: metadata sidecars are written by this store as StoredMetadata JSON.
      const metadata = JSON.parse(metadataRaw) as StoredMetadata;
      return {
        body: new Uint8Array(body),
        contentType: metadata.contentType,
        expiresAt: new Date(metadata.expiresAt),
        path: objectPath,
      };
    } catch {
      return null;
    }
  }

  async deleteExpired(before: Date): Promise<number> {
    let deleted = 0;
    /* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- expiry walk is sequential */
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          // oxlint-disable-next-line no-await-in-loop -- directory walk is sequential
          await walk(entryPath);
          continue;
        }
        if (!entry.name.endsWith(METADATA_SUFFIX)) {
          continue;
        }
        const metadataRaw = await readFile(entryPath, "utf-8");
        // SAFETY: metadata sidecars are written by this store as StoredMetadata JSON.
        const metadata = JSON.parse(metadataRaw) as StoredMetadata;
        if (new Date(metadata.expiresAt) > before) {
          continue;
        }
        const objectPath = entryPath.slice(
          0,
          entryPath.length - METADATA_SUFFIX.length
        );
        await rm(objectPath, { force: true });
        await rm(entryPath, { force: true });
        deleted += 1;
        const parent = path.dirname(objectPath);
        const parentStat = await stat(parent).catch(() => null);
        if (parentStat?.isDirectory()) {
          const remaining = await readdir(parent);
          if (remaining.length === 0) {
            await rm(parent, { force: true, recursive: true });
          }
        }
      }
    };
    /* oxlint-enable no-await-in-loop, unicorn/no-await-expression-member */
    try {
      await walk(this.rootDir);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return 0;
      }
      throw error;
    }
    return deleted;
  }
}
