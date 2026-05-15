// Returns a signed upload URL for Supabase Storage, plus the public URL
// Brad's chat route will later fetch the file from. Lazily creates the
// "jess-uploads" bucket on first use so no Supabase dashboard step is needed.
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = "jess-uploads";

async function ensureBucket() {
  const { data, error } = await supabase.storage.getBucket(BUCKET);
  if (data) return;
  if (error && !/not found/i.test(error.message)) throw error;
  // Public bucket so the chat route can fetch the file by URL without a
  // separate signed-read step. Files accumulate — set up a Supabase scheduled
  // function or manual cleanup if Brad ever needs to prune.
  const { error: createErr } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 52428800, // 50 MB
  });
  if (createErr) throw createErr;
}

export async function POST(req) {
  try {
    const { filename } = await req.json();
    if (!filename) {
      return Response.json({ success: false, error: "filename required" }, { status: 400 });
    }

    await ensureBucket();

    const safe = String(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;

    const { data, error } = await supabase
      .storage
      .from(BUCKET)
      .createSignedUploadUrl(path);
    if (error) {
      console.log("createSignedUploadUrl error:", error.message);
      return Response.json({ success: false, error: error.message }, { status: 500 });
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);

    return Response.json({
      success: true,
      uploadUrl: data.signedUrl,
      path,
      fileUrl: pub.publicUrl,
    });
  } catch (e) {
    console.log("upload-url error:", e.message);
    return Response.json({ success: false, error: e.message }, { status: 500 });
  }
}
