import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // 5274 避开 TinyFlow(5173) 与 FlowTest(5273)；strictPort 让端口冲突直接报错。
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.WEB_PORT ?? 5274),
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
