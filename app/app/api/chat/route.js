export async function POST(req) {
  const { message } = await req.json();

  return Response.json({
    reply: "Jess heard: " + message,
  });
}
