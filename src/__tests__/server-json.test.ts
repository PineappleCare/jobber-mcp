import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const serverJson = JSON.parse(readFileSync(path.join(repoRoot, "server.json"), "utf8"));

describe("server.json", () => {
  it("keeps every env var description at or under 100 characters", () => {
    const envVars = serverJson.packages[0].environmentVariables as Array<{ name: string; description: string }>;
    expect(envVars.length).toBeGreaterThan(0);
    for (const envVar of envVars) {
      expect(envVar.description.length, `${envVar.name} description is too long`).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the top-level description at or under 100 characters", () => {
    expect((serverJson.description as string).length).toBeLessThanOrEqual(100);
  });
});
