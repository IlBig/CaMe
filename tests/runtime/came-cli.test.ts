import { describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/came.js";

describe("came CLI", () => {
  it("rejects unsupported arguments without starting a session", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await expect(main(["--unknown"])).resolves.toBe(2);
      expect(stderr).toHaveBeenCalledWith("Usage: came\n");
    } finally {
      stderr.mockRestore();
    }
  });
});
