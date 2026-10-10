import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// La app se sirve compilada desde FastAPI en /ui (mismo origen que la API).
// En desarrollo (`npm run dev`), api.ts llama directo a http://localhost:8000 (CORS abierto).
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  server: { host: true },
  test: {
    environment: "jsdom",
    globals: false,
  },
});
