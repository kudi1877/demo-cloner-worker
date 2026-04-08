/**
 * upload-to-supabase.mjs
 *
 * Uploads the cloned static site to Supabase Storage.
 * Walks the output directory and uploads each file with correct content-type.
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import mime from 'mime-types';

const BUCKET_NAME = 'cloned-sites';

/**
 * Upload entire output directory to Supabase Storage
 * @param {string} outputDir - Path to the output directory
 * @param {string} demoId - Demo ID (used as folder prefix)
 * @param {string} supabaseUrl - Supabase project URL
 * @param {string} supabaseServiceKey - Supabase service role key
 * @returns {string} Public URL of the uploaded index.html
 */
export async function uploadToSupabase(outputDir, demoId, supabaseUrl, supabaseServiceKey) {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false }
  });

  // Ensure bucket exists (will skip if already exists)
  try {
    await supabase.storage.createBucket(BUCKET_NAME, {
      public: true,
      allowedMimeTypes: [
        'text/html', 'text/css', 'application/javascript',
        'image/*', 'font/*', 'video/*',
        'application/json', 'image/svg+xml'
      ]
    });
  } catch (err) {
    // Bucket likely already exists, that's fine
  }

  // Walk the output directory and collect all files
  const files = await walkDir(outputDir);
  console.log(`   Found ${files.length} files to upload`);

  // Upload in batches of 4
  const BATCH_SIZE = 4;
  const uploadedPaths = [];

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (filePath) => {
      const relativePath = path.relative(outputDir, filePath);
      const storagePath = `${demoId}/${relativePath}`;
      const contentType = mime.lookup(filePath) || 'application/octet-stream';

      const fileBuffer = await fs.readFile(filePath);

      const { error } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(storagePath, fileBuffer, {
          contentType,
          upsert: true, // Overwrite if exists (for re-clones)
          cacheControl: '3600' // 1 hour cache
        });

      if (error) {
        console.warn(`   ⚠️ Failed to upload ${relativePath}: ${error.message}`);
      } else {
        uploadedPaths.push(storagePath);
      }
    }));
  }

  console.log(`   Uploaded ${uploadedPaths.length}/${files.length} files`);

  // Get public URL for index.html
  const { data } = supabase.storage
    .from(BUCKET_NAME)
    .getPublicUrl(`${demoId}/index.html`);

  return data.publicUrl;
}

/**
 * Recursively walk a directory and return all file paths
 */
async function walkDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkDir(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}
