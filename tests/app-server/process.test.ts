import { describe, expect, it } from "vitest";

import { AppServerConnectionClosedError, spawnCodexAppServer } from "../../src/index.js";

describe("spawnCodexAppServer", () => {
  it("reports an executable start failure through the bridge", async () => {
    const { bridge } = spawnCodexAppServer({ command: "/path/that/does/not/exist" });

    const error = await new Promise<Error>((resolve) => bridge.onClose(resolve));

    expect(error).toBeInstanceOf(AppServerConnectionClosedError);
    expect(error.message).toContain("Failed to start");
  });
});
