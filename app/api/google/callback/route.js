import { google } from "googleapis";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");

    if (!code) {
      return Response.json({ error: "Missing Google authorization code" });
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code);

    return Response.json({
      message: "Google connected. Copy the refresh_token into Vercel as GOOGLE_REFRESH_TOKEN.",
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });
  } catch (error) {
    return Response.json({
      error: error.message || "Google callback error",
    });
  }
}
