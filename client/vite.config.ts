import { defineConfig } from "vite";

export default defineConfig({
  // relative base => the built site works whether hosted at a domain root
  // or a sub-path (e.g. itch.io, GitHub Pages project sites).
  base: "./",
  server: {
    // Bind to all network interfaces so other devices on the LAN can open the
    // game (e.g. http://192.168.x.x:5173), not just localhost.
    host: true,
    // Honor a PORT env var (e.g. when a preview/launcher assigns one),
    // falling back to the conventional dev port.
    port: Number(process.env.PORT) || 5173,
  },
});
