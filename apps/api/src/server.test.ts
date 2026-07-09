import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

const servers = [] as ReturnType<typeof createServer>[];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("runtime probes", () => {
  it.each(["/health", "/ready"])("answers %s", async (path) => {
    const server = createServer();
    servers.push(server);
    const response = await server.inject({ method: "GET", url: path });

    expect(response.statusCode).toBe(200);
  });
});
