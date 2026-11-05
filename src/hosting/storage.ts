import type { Bucket } from "./types";

/**
 * File storage buckets and their policies, as SQL (run through the
 * Management API's SQL endpoint — the Management API itself only lists
 * buckets). Supabase's docs create buckets with an insert into
 * storage.buckets; policies are row level security on storage.objects.
 *
 * Every bucket: people signed in to the app put files only in their own
 * folder (`<user id>/…`) and change only their own files. Private buckets:
 * they read only their own; public buckets: anyone can read.
 */

const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function checkBucket(b: Bucket): Bucket {
  if (!NAME.test(b.name)) throw new Error(`Bucket name "${b.name}": lowercase letters, digits and dashes.`);
  if (b.maxBytes !== undefined && (!Number.isInteger(b.maxBytes) || b.maxBytes <= 0)) throw new Error("A bucket's size limit is a whole number of bytes.");
  for (const m of b.mimeTypes ?? []) if (!/^[a-z]+\/[a-z0-9.+*-]+$/i.test(m)) throw new Error(`"${m}" isn't a file type like image/jpeg or image/*.`);
  return b;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const id = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Pure. Idempotent SQL for the buckets and their policies. */
export function storageSql(buckets: Bucket[]): string {
  const out: string[] = [];
  for (const raw of buckets) {
    const b = checkBucket(raw);
    const limit = b.maxBytes ?? null;
    const mimes = b.mimeTypes?.length ? `ARRAY[${b.mimeTypes.map(lit).join(", ")}]` : "NULL";
    out.push(
      `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (${lit(b.name)}, ${lit(b.name)}, ${b.public}, ${limit ?? "NULL"}, ${mimes})
  ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;`,
    );
    const own = `bucket_id = ${lit(b.name)} AND (storage.foldername(name))[1] = (SELECT auth.uid())::text`;
    const pol = (what: string) => id(`day2 ${b.name} ${what}`);
    out.push(`DROP POLICY IF EXISTS ${pol("read")} ON storage.objects;`);
    out.push(
      b.public
        ? `CREATE POLICY ${pol("read")} ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = ${lit(b.name)});`
        : `CREATE POLICY ${pol("read")} ON storage.objects FOR SELECT TO authenticated USING (${own});`,
    );
    out.push(`DROP POLICY IF EXISTS ${pol("upload")} ON storage.objects;`);
    out.push(`CREATE POLICY ${pol("upload")} ON storage.objects FOR INSERT TO authenticated WITH CHECK (${own});`);
    out.push(`DROP POLICY IF EXISTS ${pol("change")} ON storage.objects;`);
    out.push(`CREATE POLICY ${pol("change")} ON storage.objects FOR UPDATE TO authenticated USING (${own}) WITH CHECK (${own});`);
    out.push(`DROP POLICY IF EXISTS ${pol("delete")} ON storage.objects;`);
    out.push(`CREATE POLICY ${pol("delete")} ON storage.objects FOR DELETE TO authenticated USING (${own});`);
  }
  return out.join("\n");
}
