// maplibre-gl resuelve la URL de su worker a partir de `import.meta.url`. Con
// el bundler de Next esa URL no es http(s), así que la biblioteca se rinde y
// devuelve una cadena vacía: el worker nunca carga y el basemap se queda en
// negro. La solución es servir el worker desde `public/` y apuntarlo a mano
// (ver `setWorkerUrl` en MapaCalor.js).
//
// Son DOS archivos: el worker es un módulo ES que importa el chunk compartido
// que va a su lado. Copiar solo el primero deja el import en 404.
//
// Corre en `postinstall`. Si maplibre todavía no está instalado, no hace nada
// y no rompe la instalación.
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(raiz, "node_modules", "maplibre-gl", "dist");
const destinoDir = join(raiz, "public", "maplibre");
const archivos = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

const faltantes = archivos.filter((f) => !existsSync(join(dist, f)));
if (faltantes.length) {
  console.log(`[maplibre] no encuentro ${faltantes.join(", ")}; se omite la copia.`);
  process.exit(0);
}

await mkdir(destinoDir, { recursive: true });
for (const f of archivos) {
  await copyFile(join(dist, f), join(destinoDir, f));
}
console.log(`[maplibre] copiados a public/maplibre/: ${archivos.join(", ")}`);
