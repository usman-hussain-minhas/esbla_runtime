import { createServer } from "./server.js";

const port = Number.parseInt(process.env.PORT ?? "4000", 10);
const server = createServer();

await server.listen({ host: "0.0.0.0", port });
