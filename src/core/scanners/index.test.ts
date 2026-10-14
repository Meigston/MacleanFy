import { describe, it, expect } from "vitest";
import { ALL_SCANNERS, getScanner, getAllScanners } from "./index.js";
import type { CategoryId } from "../types.js";

describe("scanners index", () => {
  it("should export all scanners", () => {
    const expectedIds: CategoryId[] = [
      "system-cache",
      "system-logs",
      "temp-files",
      "trash",
      "downloads",
      "browser-cache",
      "dev-cache",
      "homebrew",
      "docker",
      "ios-backups",
      "mail-attachments",
      "language-files",
      "large-files",
      "node-modules",
      "duplicates",
      "launch-agents",
      "app-leftovers",
    ];

    expect(Object.keys(ALL_SCANNERS).sort()).toEqual(expectedIds.sort());
  });

  it("should get scanner by category id", () => {
    const scanner = getScanner("trash");

    expect(scanner).toBeDefined();
    expect(scanner.category.id).toBe("trash");
  });

  it("should get all scanners", () => {
    const scanners = getAllScanners();

    expect(scanners).toHaveLength(17);
    for (const scanner of scanners) {
      expect(scanner.category).toBeDefined();
      expect(scanner.scan).toBeDefined();
      expect(scanner.clean).toBeDefined();
    }
  });

  it("should have scan method for all scanners", () => {
    const scanners = getAllScanners();

    for (const scanner of scanners) {
      expect(scanner.scan).toBeDefined();
      expect(typeof scanner.scan).toBe("function");
    }
  });

  it("should have clean method for all scanners", () => {
    const scanners = getAllScanners();

    for (const scanner of scanners) {
      expect(scanner.clean).toBeDefined();
      expect(typeof scanner.clean).toBe("function");
    }
  });

  it("should have matching category ids", () => {
    for (const [id, scanner] of Object.entries(ALL_SCANNERS)) {
      expect(scanner.category.id).toBe(id);
    }
  });

  it("should throw for unknown scanner category id", () => {
    expect(() => getScanner("unknown-category" as CategoryId)).toThrowError(
      "Unknown scanner category: unknown-category",
    );
  });
});
