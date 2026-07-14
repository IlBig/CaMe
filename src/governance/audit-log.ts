import { type FileHandle, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import { modelProfileSchema } from "../contracts.js";

export const auditEventTypeSchema = z.enum([
  "switch_requested",
  "confirmation_required",
  "confirmation_consumed",
  "confirmation_rejected",
  "confirmation_expired",
  "switch_scheduled",
  "settings_applied",
  "continuation_started",
  "chain_reset",
  "handoff_failed",
]);

export const auditDecisionSchema = z.enum([
  "required",
  "unknown_or_consumed",
  "stale_context",
  "confirmed",
  "autonomous",
  "explicit",
  "new_turn",
  "new_turn_confirmation_invalidated",
  "expired",
]);

export const auditEventSchema = z.object({
  timestamp: z.iso.datetime(),
  sessionId: z.uuid(),
  event: auditEventTypeSchema,
  requestId: z.uuid().optional(),
  switchId: z.uuid().optional(),
  chainId: z.uuid().nullable().optional(),
  threadId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  sourceProfile: modelProfileSchema.nullable().optional(),
  targetProfile: modelProfileSchema.optional(),
  decision: auditDecisionSchema.optional(),
  reasonFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  reasonLength: z.number().int().min(0).optional(),
  continuationLength: z.number().int().min(0).optional(),
  errorName: z.string().min(1).optional(),
}).strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditEventInput = Omit<AuditEvent, "timestamp" | "sessionId">;

export interface AuditSink {
  record(event: AuditEventInput): Promise<void>;
}

export class AuditLogError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditLogError";
  }
}

export class JsonlAuditLog implements AuditSink {
  readonly #sessionId: string;
  readonly #handle: FileHandle;
  #writeQueue: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | null = null;
  #closing = false;

  private constructor(sessionId: string, handle: FileHandle) {
    this.#sessionId = sessionId;
    this.#handle = handle;
  }

  public static async create(path: string, sessionId: string): Promise<JsonlAuditLog> {
    if (!isAbsolute(path)) {
      throw new RangeError("Audit log path must be absolute");
    }
    z.uuid().parse(sessionId);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await stat(directory);
    if ((directoryStat.mode & 0o077) !== 0) {
      throw new AuditLogError("Audit log directory must not be accessible by group or other users");
    }
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      throw new AuditLogError("Could not create audit log", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    try {
      await handle.chmod(0o600);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
      try {
        await rm(path, { force: false });
      } catch (removeError) {
        cleanupErrors.push(removeError);
      }
      const permissionError = new AuditLogError("Could not restrict audit log permissions", {
        cause: error instanceof Error ? error : undefined,
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError([permissionError, ...cleanupErrors], "Audit log initialization and cleanup failed");
      }
      throw permissionError;
    }
    return new JsonlAuditLog(sessionId, handle);
  }

  public record(input: AuditEventInput): Promise<void> {
    if (this.#closing) {
      return Promise.reject(new AuditLogError("Audit log is closing"));
    }
    const event = auditEventSchema.parse({
      ...input,
      timestamp: new Date().toISOString(),
      sessionId: this.#sessionId,
    });
    const line = `${JSON.stringify(event)}\n`;
    const write = this.#writeQueue.then(async () => {
      try {
        await this.#handle.writeFile(line);
        await this.#handle.sync();
      } catch (error) {
        throw new AuditLogError("Could not persist audit event", {
          cause: error instanceof Error ? error : undefined,
        });
      }
    });
    this.#writeQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  public close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#writeQueue;
      try {
        await this.#handle.close();
      } catch (error) {
        throw new AuditLogError("Could not close audit log", {
          cause: error instanceof Error ? error : undefined,
        });
      }
    })();
    return this.#closePromise;
  }
}
