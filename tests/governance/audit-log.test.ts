import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AuditLogError,
  JsonlAuditLog,
  auditEventSchema,
  type AuditEventInput,
} from "../../src/index.js";

describe("JsonlAuditLog", () => {
  it("persists ordered, private, schema-valid JSONL records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "came-audit-test-"));
    await chmod(directory, 0o700);
    const path = join(directory, "audit.jsonl");
    const sessionId = randomUUID();
    const log = await JsonlAuditLog.create(path, sessionId);
    try {
      await Promise.all([
        log.record({ event: "switch_requested", requestId: randomUUID(), reasonFingerprint: "a".repeat(64), reasonLength: 12, continuationLength: 34 }),
        log.record({ event: "switch_scheduled", switchId: randomUUID(), decision: "autonomous" }),
      ]);
      await log.close();

      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const text = await readFile(path, "utf8");
      const lines = text.trim().split("\n").map((line) => JSON.parse(line) as unknown);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => auditEventSchema.parse(line).event)).toEqual(["switch_requested", "switch_scheduled"]);
      expect(text).not.toContain("private reason");
      expect(text).not.toContain("private continuation");
    } finally {
      await log.close();
      await rm(directory, { recursive: true, force: false });
    }
  });

  it("rejects arbitrary fields and records after close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "came-audit-strict-"));
    await chmod(directory, 0o700);
    const path = join(directory, "audit.jsonl");
    const log = await JsonlAuditLog.create(path, randomUUID());
    try {
      expect(() => log.record({ event: "switch_requested", reason: "private" } as unknown as AuditEventInput)).toThrow();
      await log.close();
      await expect(log.record({ event: "chain_reset", decision: "new_turn" })).rejects.toBeInstanceOf(AuditLogError);
    } finally {
      await log.close();
      await rm(directory, { recursive: true, force: false });
    }
  });

  it("rejects duplicate files, relative paths, and non-private directories", async () => {
    const privateDirectory = await mkdtemp(join(tmpdir(), "came-audit-exclusive-"));
    await chmod(privateDirectory, 0o700);
    const path = join(privateDirectory, "audit.jsonl");
    const log = await JsonlAuditLog.create(path, randomUUID());
    try {
      await expect(JsonlAuditLog.create(path, randomUUID())).rejects.toBeInstanceOf(AuditLogError);
      await expect(JsonlAuditLog.create("relative.jsonl", randomUUID())).rejects.toBeInstanceOf(RangeError);
    } finally {
      await log.close();
      await rm(privateDirectory, { recursive: true, force: false });
    }

    const publicDirectory = await mkdtemp(join(tmpdir(), "came-audit-public-"));
    await chmod(publicDirectory, 0o755);
    try {
      await expect(JsonlAuditLog.create(join(publicDirectory, "audit.jsonl"), randomUUID())).rejects.toBeInstanceOf(AuditLogError);
    } finally {
      await rm(publicDirectory, { recursive: true, force: false });
    }
  });
});
