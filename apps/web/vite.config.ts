import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API = process.env.VITE_API_URL ?? "http://127.0.0.1:3000";
const explicitProxyPaths = ["/api", "/v2", "/token"];
const registryPathProxy = "^/[^/.][^/]*/[^/]+/[^/]+(?:/.*)?$";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: Object.fromEntries(
      [...explicitProxyPaths, registryPathProxy].map((p) => [
        p,
        { target: API, changeOrigin: true, xfwd: true },
      ]),
    ),
  },
  build: { outDir: "dist", sourcemap: false },
});
