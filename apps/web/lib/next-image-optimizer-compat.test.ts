import { getImageSize, getSharp, optimizeImage } from "next/dist/server/image-optimizer.js";
import { describe, expect, it } from "vitest";

describe("Next image optimizer dependency compatibility", () => {
  it("optimizes an actual PNG through the scoped patched Sharp runtime", async () => {
    const sharp = getSharp(null);
    const source = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWPgUbL4D8IMMAYALGgFlcy8lt0AAAAASUVORK5CYII=",
      "base64",
    );

    const optimized = await optimizeImage({
      buffer: source,
      contentType: "image/png",
      quality: 75,
      width: 1,
    });
    const size = await getImageSize(optimized);

    expect(sharp.versions.sharp).toBe("0.35.3");
    expect(sharp.versions.vips).toBe("8.18.3");
    expect(size).toEqual({ height: 1, width: 1 });
  });
});
