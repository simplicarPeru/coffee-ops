// Almacenamiento de fotos.
// - Producción: bucket privado en Supabase Storage. Las fotos se sirven con URLs firmadas que expiran.
// - Local (sin variables de Supabase): carpeta ./uploads, servida por el propio servidor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = path.join(__dirname, '..', 'uploads');
const BUCKET = process.env.SUPABASE_BUCKET || 'fotos';
const SIGNED_SECONDS = 60 * 60;

const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

export const storageMode = supabase ? 'supabase' : 'local';
export const LOCAL_UPLOADS_DIR = LOCAL_DIR;

export async function uploadPhoto(relPath, buffer, contentType) {
  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(relPath, buffer, { contentType, upsert: false });
    if (error) throw new Error(`No se pudo guardar la foto: ${error.message}`);
    return;
  }
  const abs = path.join(LOCAL_DIR, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
}

export async function removePhoto(relPath) {
  if (supabase) {
    await supabase.storage.from(BUCKET).remove([relPath]);
    return;
  }
  fs.rm(path.join(LOCAL_DIR, relPath), { force: true }, () => {});
}

// Devuelve un Map(ruta -> URL) para mostrar las fotos.
export async function signUrls(relPaths) {
  const out = new Map();
  if (!relPaths.length) return out;
  if (supabase) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(relPaths, SIGNED_SECONDS);
    if (error) throw new Error(`No se pudieron generar los enlaces de las fotos: ${error.message}`);
    for (const d of data) if (d.signedUrl) out.set(d.path, d.signedUrl);
    return out;
  }
  for (const p of relPaths) out.set(p, `/uploads/${p}`);
  return out;
}
