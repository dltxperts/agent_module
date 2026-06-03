import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { FileStoreService, type FileObject } from "../runtime/file-store.service";

interface DownloadResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

@Controller("/v1/files")
export class FilesController {
  constructor(private readonly files: FileStoreService) {}

  @Post()
  @UseInterceptors(FileInterceptor("file"))
  async upload(@UploadedFile() file: { originalname: string; mimetype: string; buffer: Buffer }): Promise<FileObject> {
    return this.files.create({
      name: file.originalname,
      mimeType: file.mimetype,
      bytes: file.buffer,
    });
  }

  @Get(":id/metadata")
  metadata(@Param("id") id: string): Promise<FileObject> {
    return this.files.getMetadata(id);
  }

  @Get(":id")
  async download(@Param("id") id: string, @Res() res: DownloadResponse): Promise<void> {
    const { metadata, bytes } = await this.files.getBytes(id);
    res.setHeader("Content-Type", metadata.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${metadata.name}"`);
    res.send(bytes);
  }

  @Delete(":id")
  async delete(@Param("id") id: string): Promise<{ id: string; status: "deleted" }> {
    await this.files.delete(id);
    return { id, status: "deleted" };
  }
}
