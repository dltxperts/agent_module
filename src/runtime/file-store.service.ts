import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { RuntimeConfigService } from "./config.service";
import { readJsonFile, writeJsonFile } from "./json-store";

export interface FileObject {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  storage_path: string;
  created_at: string;
}

@Injectable()
export class FileStoreService {
  private readonly metadataDir: string;
  private readonly blobsDir: string;

  constructor(config: RuntimeConfigService) {
    this.metadataDir = join(config.agentHome, "files", "metadata");
    this.blobsDir = join(config.agentHome, "files", "blobs");
  }

  async create(input: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<FileObject> {
    await mkdir(this.metadataDir, { recursive: true });
    await mkdir(this.blobsDir, { recursive: true });

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const id = `file_${sha256.slice(0, 24)}`;
    const storagePath = join(this.blobsDir, id);
    const metadata: FileObject = {
      id,
      name: input.name,
      mime_type: input.mimeType || "application/octet-stream",
      size: input.bytes.byteLength,
      sha256,
      storage_path: storagePath,
      created_at: new Date().toISOString(),
    };

    await writeFile(storagePath, input.bytes);
    await writeJsonFile(this.metadataPath(id), metadata);
    return metadata;
  }

  async getMetadata(id: string): Promise<FileObject> {
    const metadata = await readJsonFile<FileObject | null>(this.metadataPath(id), null);
    if (!metadata) throw new NotFoundException(`Unknown file: ${id}`);
    return metadata;
  }

  async getBytes(id: string): Promise<{ metadata: FileObject; bytes: Buffer }> {
    const metadata = await this.getMetadata(id);
    return {
      metadata,
      bytes: await readFile(metadata.storage_path),
    };
  }

  async delete(id: string): Promise<void> {
    const metadata = await readJsonFile<FileObject | null>(this.metadataPath(id), null);
    await rm(this.metadataPath(id), { force: true });
    if (metadata) await rm(metadata.storage_path, { force: true });
  }

  private metadataPath(id: string): string {
    return join(this.metadataDir, `${id}.json`);
  }
}
