// Serves the demo with Bun's HTML bundler: `bun run demo`, then open http://localhost:5177/ (add #7 for frame 7).
import index from "./index.html";

const server = Bun.serve({ port: Number(process.env.PORT ?? 5177), routes: { "/": index }, development: true });
console.log(`Settings demo at ${server.url}`);
