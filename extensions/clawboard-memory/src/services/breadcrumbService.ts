import fs from "node:fs/promises";
import path from "node:path";
import type { PluginLogger } from "../../api.js";
import { BreadcrumbSchema, type BreadcrumbRecord } from "../types/tool.js";
import { createComponentLogger } from "../utils/logger.js";
import { safeJsonParse } from "../utils/validation.js";

export class BreadcrumbService {
  private readonly logger: PluginLogger;

  constructor(
    private readonly filePath: string,
    logger: PluginLogger,
  ) {
    this.logger = createComponentLogger(logger, "breadcrumb");
  }

  async read(): Promise<BreadcrumbRecord | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = safeJsonParse<unknown>(raw);
      const result = BreadcrumbSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  async write(update: Partial<BreadcrumbRecord>): Promise<BreadcrumbRecord | null> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const previous = (await this.read()) ?? null;
      const next = BreadcrumbSchema.parse({
        ...(previous ?? {}),
        ...update,
        updatedAt: new Date().toISOString(),
      });
      await fs.writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
      return next;
    } catch (error) {
      this.logger.warn(
        `breadcrumb write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.filePath, { force: true });
    } catch (error) {
      this.logger.warn(
        `breadcrumb clear failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
